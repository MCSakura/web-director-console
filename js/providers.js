/**
 * 拉流通道（Provider）
 *
 * 统一接口：把「某个云的播放地址」变成原生 MediaStreamTrack，供帧同步模块使用。
 * 所有 provider 都实现：
 *   start()  建立连接（成功即代表轨道即将通过 onTrack 回调送出）
 *   close()  释放全部资源，可重复调用
 *
 * 通过构造参数 options 回调上层：
 *   options.onTrack(track)        每收到一条轨道回调一次
 *   options.onStateChange(state)  连接状态变化（失败/断开时上报）
 *
 * 为什么统一在"原生轨道"这一层：多机位帧级同步依赖 MediaStreamTrackProcessor
 * 逐帧读取带 PTS 的 VideoFrame，因此只要 provider 能给出原生轨道，同步/合成/
 * 输出三层就完全不用改。
 */

/**
 * 取某路机位的拉流地址：
 * 优先用「每路机位拉流地址」里为该机位单独填的完整地址（腾讯云 / 阿里云都直接粘原地址）；
 * 没填则回退到地址模板，把 {cam} {base} {app} 替换成实际值。
 */
function buildStreamUrl(cloud, camId, cfg) {
  var perCam = String((cloud.urls && cloud.urls[camId]) || "").trim();
  if (perCam) return perCam;

  var base = cloud.base !== undefined ? cloud.base : cfg.serverBase;
  var app = cloud.app !== undefined ? cloud.app : cfg.app;
  return String(cloud.urlTemplate || "")
    .replace(/\{cam\}/g, camId)
    .replace(/\{base\}/g, base)
    .replace(/\{app\}/g, app);
}

/**
 * 播放器只用来取轨道，声音一律交给混音器（「本机监听」开关才决定是否外放）。
 * 但云播放器 SDK 有时会在起播/切流时把 <video> 的 muted 改回去，
 * 声音就会绕过混音器直接从扬声器出来。这里强制静音，并在关键事件上再兜一层。
 */
function forceMuteVideo(video) {
  if (!video) return;
  video.muted = true;
  video.defaultMuted = true;
  video.setAttribute("muted", "");
  video.volume = 0;

  if (video._muteGuard) return;
  video._muteGuard = true;

  var reassert = function () {
    video.muted = true;
    video.volume = 0;
  };
  ["play", "playing", "volumechange", "loadeddata", "canplay"].forEach(function (ev) {
    video.addEventListener(ev, reassert);
  });
}

/** 按 id 取当前生效的拉流通道 */
function getActiveCloud(cfg) {
  var id = cfg.activeCloud;
  var list = cfg.clouds || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return list[0];
}

/** 按 id 取通道 */
function getCloudById(cfg, id) {
  var list = cfg.clouds || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/* ==================== 拉流协议 / 编码探测（供「拉流状态」面板用） ==================== */

/**
 * 从拉流地址判断用的是哪种协议、是不是超低延迟方案。
 * 超低延迟（artc=RTS / webrtc=快直播 / whep）才可能涉及云端自动转码；
 * flv / hls / rtmp 属于标准直播，直接透传、不转码，但延迟高。
 */
function describeStreamUrl(url) {
  var s = String(url || "").trim().toLowerCase();
  if (!s) return { protocol: "—", lowLatency: false, ultraLow: false };
  if (s.indexOf("artc://") === 0) return { protocol: "artc (RTS)", lowLatency: true, ultraLow: true };
  if (s.indexOf("webrtc://") === 0) return { protocol: "webrtc (快直播)", lowLatency: true, ultraLow: true };
  if (s.indexOf("rtmp://") === 0) return { protocol: "rtmp", lowLatency: false, ultraLow: false };
  if (s.indexOf("/index/api/webrtc") >= 0) return { protocol: "whep (ZLMediaKit)", lowLatency: true, ultraLow: true };
  if (s.indexOf(".m3u8") >= 0) return { protocol: "hls", lowLatency: false, ultraLow: false };
  if (s.indexOf(".flv") >= 0) return { protocol: "flv", lowLatency: false, ultraLow: false };
  if (s.indexOf("http://") === 0 || s.indexOf("https://") === 0) {
    return { protocol: "http(s)", lowLatency: false, ultraLow: false };
  }
  return { protocol: "自定义", lowLatency: false, ultraLow: false };
}

/** SDP 里这些不是真正的编解码，跳过 */
var SDP_CODEC_IGNORE = { red: 1, rtx: 1, ulpfec: 1, cn: 1, telephone_event: 1, "rtx/90000": 1 };

/** 从 SDP 里取每个 m= 段实际协商的编解码（取第一个 rtpmap） */
function parseSdpCodecs(sdp) {
  var out = { audio: "", video: "" };
  if (!sdp) return out;

  var cur = null;
  var lines = String(sdp).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("m=audio") === 0) { cur = "audio"; continue; }
    if (line.indexOf("m=video") === 0) { cur = "video"; continue; }
    if (!cur || out[cur]) continue;
    var m = /^a=rtpmap:\d+\s+([A-Za-z0-9._-]+)/.exec(line);
    if (m && !SDP_CODEC_IGNORE[m[1].toLowerCase()]) out[cur] = m[1];
  }
  return out;
}

/**
 * 云播放器 SDK 把 RTCPeerConnection 藏在自己内部，外部拿不到 receiver，
 * 也就读不到实际用了什么编码。这里在 setRemoteDescription 上挂一层，
 * 把协商好的编解码记在连接对象上；之后用「轨道 → 哪个连接的 receiver 拿着它」
 * 反查，就能知道每路机位实际在用的编码。
 *
 * 只做只读观察，不改变原有行为。safari 等不支持时静默跳过。
 */
var sniffedPcs = [];

function installCodecSniffer() {
  if (typeof RTCPeerConnection === "undefined") return;
  var proto = RTCPeerConnection.prototype;
  if (proto.__codecSniffer) return;

  var orig = proto.setRemoteDescription;
  proto.setRemoteDescription = function (desc) {
    try {
      if (sniffedPcs.indexOf(this) < 0) sniffedPcs.push(this);
      if (desc && desc.sdp) {
        // answer 才是最终协商结果（第一个 rtpmap 就是选中项）；offer 只作兜底
        if (desc.type === "answer" || !this.__codecs) {
          this.__codecs = parseSdpCodecs(desc.sdp);
        }
      }
    } catch (e) { /* ignore */ }
    return orig.apply(this, arguments);
  };
  proto.__codecSniffer = true;
}

/** 按轨道反查它所在连接协商到的编解码；查不到返回 null */
function codecForTrack(track) {
  if (!track) return null;

  var alive = [];
  var found = null;

  for (var i = 0; i < sniffedPcs.length; i++) {
    var pc = sniffedPcs[i];

    var closed = false;
    try { closed = pc.connectionState === "closed"; } catch (e) { closed = true; }
    if (closed) continue; // 顺手剔掉已关闭的连接，避免重连次数多了越攒越多
    alive.push(pc);

    if (found || !pc.__codecs) continue;
    try {
      var recvs = pc.getReceivers();
      for (var j = 0; j < recvs.length; j++) {
        if (recvs[j].track === track) { found = pc.__codecs; break; }
      }
    } catch (e) { /* ignore */ }
  }

  sniffedPcs = alive;
  return found;
}

installCodecSniffer();

// ============ 通道一：标准 WHEP / SDP 拉流 ============
class WhepProvider {
  constructor(cloud, camId, cfg, options) {
    this.cloud = cloud;
    this.camId = camId;
    this.cfg = cfg;
    this.options = options || {};
    this.client = null;
  }

  async start() {
    var url = buildStreamUrl(this.cloud, this.camId, this.cfg);
    this.client = new WhepClient({
      urls: [url],
      onTrack: this.options.onTrack,
      onStateChange: this.options.onStateChange
    });
    await this.client.connect();
  }

  close() {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}

// ============ 通道二：腾讯云快直播 LEB（TCPlayer） ============
/** SDK 全局只加载一次 */
var tcplayerLoading = null;
function loadTCPlayer(sdkUrl) {
  if (typeof window.TCPlayer !== "undefined") return Promise.resolve();
  if (tcplayerLoading) return tcplayerLoading;

  tcplayerLoading = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = sdkUrl;
    s.onload = function () { resolve(); };
    s.onerror = function () {
      tcplayerLoading = null;
      reject(new Error("TCPlayer 脚本加载失败：" + sdkUrl));
    };
    document.head.appendChild(s);
  });
  return tcplayerLoading;
}

class TcPlayerProvider {
  constructor(cloud, camId, cfg, options) {
    this.cloud = cloud;
    this.camId = camId;
    this.cfg = cfg;
    this.options = options || {};
    this.player = null;
    this.video = null;
    this.timer = null;
    this.closed = false;
  }

  async start() {
    if (!this.cloud.sdkUrl) throw new Error("该通道未配置 TCPlayer SDK 地址");

    await loadTCPlayer(this.cloud.sdkUrl);
    if (this.closed) return;

    var url = buildStreamUrl(this.cloud, this.camId, this.cfg);

    // TCPlayer 4.x 要求容器必须是 <video> 元素（用 <div> 会报 "The element type must be <video>"）。
    // 放在屏幕外但保持正常尺寸渲染，避免浏览器对极小元素做解码节流。
    var video = document.createElement("video");
    video.id = "tcp-" + this.camId + "-" + Date.now();
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.muted = true;
    video.style.cssText =
      "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;";
    document.body.appendChild(video);
    this.video = video;
    forceMuteVideo(video);

    var opts = {
      sources: [{ src: url, type: "webrtc" }],
      autoplay: true,
      muted: true,
      width: 640,
      height: 360
    };
    if (this.cloud.licenseUrl) opts.licenseUrl = this.cloud.licenseUrl;
    if (this.cloud.licenseKey) opts.licenseKey = this.cloud.licenseKey;

    this.player = window.TCPlayer(video.id, opts);
    this._waitForStream();
  }

  /** 轮询 video.srcObject，拿到原生 MediaStream 后把轨道交出去 */
  _waitForStream() {
    var self = this;
    var waited = 0;
    var TIMEOUT = 30000;

    function tick() {
      if (self.closed) return;

      forceMuteVideo(self.video);

      var so = self.video && self.video.srcObject;
      if (so && typeof MediaStream !== "undefined" && so instanceof MediaStream) {
        var tracks = so.getTracks();
        if (tracks.length) {
          tracks.forEach(function (t) {
            if (self.options.onTrack) self.options.onTrack(t);
          });
          return;
        }
      }

      waited += 300;
      if (waited >= TIMEOUT) {
        if (self.options.onStateChange) self.options.onStateChange("failed");
        return;
      }
      self.timer = setTimeout(tick, 300);
    }
    tick();
  }

  close() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.player) {
      try { this.player.dispose(); } catch (e) { /* ignore */ }
      this.player = null;
    }
    if (this.video) {
      try { this.video.srcObject = null; } catch (e) { /* ignore */ }
      if (this.video.parentNode) this.video.parentNode.removeChild(this.video);
      this.video = null;
    }
  }
}

// ============ 通道三：阿里云视频直播（Aliplayer Web SDK） ============
/**
 * Aliplayer 内置了 Web RTS SDK 插件，可直接播放 artc:// 超低延时地址；
 * 也支持标准直播的 http-flv / hls 地址（此时会自动降级）。
 * 与腾讯云通道一样，从播放器的 <video> 里取原生轨道给帧同步模块。
 */
var aliplayerLoading = null;
function loadAliplayer(sdkUrl) {
  if (typeof window.Aliplayer !== "undefined") return Promise.resolve();
  if (aliplayerLoading) return aliplayerLoading;

  aliplayerLoading = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = sdkUrl;
    s.onload = function () { resolve(); };
    s.onerror = function () {
      aliplayerLoading = null;
      reject(new Error("Aliplayer 脚本加载失败：" + sdkUrl));
    };
    document.head.appendChild(s);
  });
  return aliplayerLoading;
}

class AliplayerProvider {
  constructor(cloud, camId, cfg, options) {
    this.cloud = cloud;
    this.camId = camId;
    this.cfg = cfg;
    this.options = options || {};
    this.player = null;
    this.container = null;
    this.video = null;
    this.timer = null;
    this.closed = false;
    this.emitted = false;
  }

  async start() {
    if (!this.cloud.sdkUrl) throw new Error("该通道未配置 Aliplayer SDK 地址");

    await loadAliplayer(this.cloud.sdkUrl);
    if (this.closed) return;

    var url = buildStreamUrl(this.cloud, this.camId, this.cfg);

    // Aliplayer 需要一个带 id 的容器；放到屏幕外但保持正常尺寸渲染，避免浏览器对极小元素做解码节流。
    var cid = "alip-" + this.camId + "-" + Date.now();
    var box = document.createElement("div");
    box.id = cid;
    box.style.cssText =
      "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;";
    document.body.appendChild(box);
    this.container = box;

    this.player = new window.Aliplayer({
      id: cid,
      source: url,
      isLive: true,
      autoplay: true,
      muted: true,
      playsinline: true,
      width: "640px",
      height: "360px"
    });
    this._waitForStream();
  }

  /**
   * 轮询播放器内部的 <video>：优先取原生 MediaStream（RTS/WebRTC 播放时 srcObject 即底层流）；
   * 若长时间拿不到（例如降级成 http-flv 的 MSE 播放），退化为从 <video> 元素抓取轨道。
   */
  _waitForStream() {
    var self = this;
    var waited = 0;
    var TIMEOUT = 30000;

    function tick() {
      if (self.closed || self.emitted) return;

      var video = self.video || (self.container && self.container.querySelector("video"));
      if (video) self.video = video;
      forceMuteVideo(video);

      var so = video && video.srcObject;
      if (so && typeof MediaStream !== "undefined" && so instanceof MediaStream) {
        var tracks = so.getTracks();
        if (tracks.length) {
          self._emit(tracks);
          return;
        }
      }

      waited += 300;
      if (waited >= TIMEOUT) {
        var fallback = self._captureFromVideo(video);
        if (fallback) {
          self._emit(fallback.getTracks());
          return;
        }
        if (self.options.onStateChange) self.options.onStateChange("failed");
        return;
      }
      self.timer = setTimeout(tick, 300);
    }
    tick();
  }

  _emit(tracks) {
    if (this.emitted) return;
    this.emitted = true;
    var self = this;
    tracks.forEach(function (t) {
      if (self.options.onTrack) self.options.onTrack(t);
    });
  }

  /** 兜底：从 <video> 元素抓取轨道（拿不到原生轨道时才用） */
  _captureFromVideo(video) {
    if (!video || typeof video.captureStream !== "function") return null;
    try {
      var ms = video.captureStream();
      return ms && ms.getTracks().length ? ms : null;
    } catch (e) {
      return null;
    }
  }

  close() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.player) {
      try { this.player.dispose(); } catch (e) { /* ignore */ }
      this.player = null;
    }
    if (this.video) {
      try { this.video.srcObject = null; } catch (e) { /* ignore */ }
      this.video = null;
    }
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }
}

// ============ 本地素材通道（本地图片 / 本地视频，用于测试或垫片） ============

/** 把 File 读成 HTMLImageElement（连同 objectURL，供释放用） */
function loadImageFile(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { resolve({ img: img, url: url }); };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("图片加载失败：" + (file && file.name ? file.name : "")));
    };
    img.src = url;
  });
}

/**
 * 本地图片：画进 canvas，再按目标帧率手动 requestFrame() 持续产出静止画面。
 * 用 captureStream(0) 手动出帧，是因为静止画面会被浏览器判定成"没有变化"而不产帧，
 * 那样帧同步就拿不到足够素材了。
 */
class LocalImageProvider {
  constructor(source, cfg, options) {
    this.source = source;
    this.cfg = cfg;
    this.options = options || {};
    this.canvas = null;
    this.stream = null;
    this.objectUrl = null;
    this.timer = null;
    this.closed = false;
  }

  async start() {
    var res = await loadImageFile(this.source.file);
    if (this.closed) {
      URL.revokeObjectURL(res.url);
      return;
    }
    this.objectUrl = res.url;

    var img = res.img;
    var w = img.naturalWidth || 1280;
    var h = img.naturalHeight || 720;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    this.canvas = canvas;

    var stream = canvas.captureStream(0);
    this.stream = stream;
    var track = stream.getVideoTracks()[0];
    if (track && this.options.onTrack) this.options.onTrack(track);

    var fps = Math.min(30, (this.cfg.output && this.cfg.output.fps) || 30);
    this.timer = setInterval(function () {
      try { if (track) track.requestFrame(); } catch (e) { /* ignore */ }
    }, Math.round(1000 / fps));
  }

  close() {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      this.stream = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.canvas = null;
  }
}

/**
 * 本地视频文件：<video> 循环播放，用 captureStream() 取轨道（有音轨就一起给混音器）。
 * 元素强制静音，避免绕过混音器直接外放。
 */
class LocalVideoProvider {
  constructor(source, cfg, options) {
    this.source = source;
    this.cfg = cfg;
    this.options = options || {};
    this.video = null;
    this.stream = null;
    this.objectUrl = null;
    this.timer = null;
    this.closed = false;
  }

  async start() {
    var v = document.createElement("video");
    v.src = URL.createObjectURL(this.source.file);
    this.objectUrl = v.src;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    v.style.cssText =
      "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;";
    document.body.appendChild(v);
    forceMuteVideo(v);
    this.video = v;

    try { await v.play(); } catch (e) { /* 自动播放可能被拦，下面轮询里再试 */ }
    this._waitForStream();
  }

  _waitForStream() {
    var self = this;
    var waited = 0;
    var TIMEOUT = 20000;

    function tick() {
      if (self.closed) return;

      forceMuteVideo(self.video);
      try { if (self.video && self.video.paused) self.video.play(); } catch (e) { /* ignore */ }

      // readyState >= 2 才有可用画面
      if (self.video && self.video.readyState >= 2 && self.video.captureStream) {
        var stream = self.video.captureStream();
        var tracks = stream ? stream.getTracks() : [];
        if (tracks.length) {
          self.stream = stream;
          tracks.forEach(function (t) {
            if (self.options.onTrack) self.options.onTrack(t);
          });
          return;
        }
      }

      waited += 300;
      if (waited >= TIMEOUT) {
        if (self.options.onStateChange) self.options.onStateChange("failed");
        return;
      }
      self.timer = setTimeout(tick, 300);
    }
    tick();
  }

  close() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      this.stream = null;
    }
    if (this.video) {
      try { this.video.pause(); } catch (e) { /* ignore */ }
      this.video.src = "";
      if (this.video.parentNode) this.video.parentNode.removeChild(this.video);
      this.video = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

/**
 * 本机摄像头 / 麦克风：直接 getUserMedia 取轨道，不走网络。
 *
 * 注意：浏览器只在「安全上下文」下开放摄像头，即 https:// 或 localhost。
 * 用 http://内网IP 打开时 navigator.mediaDevices 是 undefined，这里会给出明确报错。
 */
class LocalCameraProvider {
  constructor(source, cfg, options) {
    this.source = source;
    this.cfg = cfg;
    this.options = options || {};
    this.stream = null;
    this.closed = false;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        "本机摄像头只能在 HTTPS 或 localhost 下使用（当前页面是 " +
        location.protocol + "//" + location.host + "，浏览器已禁用摄像头）"
      );
    }

    var video = (this.source && this.source.deviceId)
      ? { deviceId: { exact: this.source.deviceId } }
      : true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: true });
    } catch (err) {
      // 有些设备/权限只给到摄像头，没麦克风；退一步只取视频
      this.stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: false });
    }

    if (this.closed) {
      this._stop();
      return;
    }
    this.stream.getTracks().forEach((t) => {
      if (this.options.onTrack) this.options.onTrack(t);
    });
  }

  close() {
    this.closed = true;
    this._stop();
  }

  _stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      this.stream = null;
    }
  }
}

/**
 * 按「机位来源」创建本地素材通道。
 * source.type 为 "pull" 或没设时返回 null，表示走云端拉流通道。
 */
function createLocalProvider(source, cfg, options) {
  if (!source || !source.type || source.type === "pull") return null;

  if (source.type === "camera") return new LocalCameraProvider(source, cfg, options);

  if (source.type === "image" || source.type === "video") {
    if (!source.file) throw new Error("还没选择本地文件");
    return source.type === "image"
      ? new LocalImageProvider(source, cfg, options)
      : new LocalVideoProvider(source, cfg, options);
  }

  throw new Error("未知的机位来源：" + source.type);
}

// ============ 工厂 ============
function createStreamProvider(cloud, camId, cfg, options) {
  if (!cloud) throw new Error("未找到拉流通道配置");
  switch (cloud.provider) {
    case "whep":
      return new WhepProvider(cloud, camId, cfg, options);
    case "tcplayer":
      return new TcPlayerProvider(cloud, camId, cfg, options);
    case "aliplayer":
      return new AliplayerProvider(cloud, camId, cfg, options);
    default:
      throw new Error("未知的拉流方式：" + cloud.provider);
  }
}
