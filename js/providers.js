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
