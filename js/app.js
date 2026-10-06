/**
 * 主逻辑：串联各模块并绑定导播控制面板。
 */
(function () {
  "use strict";

  const CFG = window.DIRECTOR_CONFIG;
  const $ = (id) => document.getElementById(id);

  const ui = {
    outputCanvas: $("outputCanvas"),
    outputPlaceholder: $("outputPlaceholder"),
    outputHint: $("outputHint"),
    programBadge: $("programBadge"),
    multiviewGrid: $("multiviewGrid"),
    statRef: $("statRef"),
    statFps: $("statFps"),
    statOutput: $("statOutput"),
    btnConnect: $("btnConnect"),
    btnDisconnect: $("btnDisconnect"),
    pgmButtons: $("pgmButtons"),
    pipEnabled: $("pipEnabled"),
    pipSelect: $("pipSelect"),
    syncMaxDelayInput: $("syncMaxDelayInput"),
    syncExtraDelayInput: $("syncExtraDelayInput"),
    syncDelayInfo: $("syncDelayInfo"),
    transRange: $("transRange"),
    transVal: $("transVal"),
    logoInput: $("logoInput"),
    logoSizeRange: $("logoSizeRange"),
    logoSizeVal: $("logoSizeVal"),
    btnClearLogo: $("btnClearLogo"),
    audioList: $("audioList"),
    masterVol: $("masterVol"),
    monitorChk: $("monitorChk"),
    outputSelect: $("outputSelect"),
    outputLight: $("outputLight"),
    outputInfo: $("outputInfo"),
    pushEnabled: $("pushEnabled"),
    pushTokenInput: $("pushTokenInput"),
    pushCloudSelect: $("pushCloudSelect"),
    pushCloudHint: $("pushCloudHint"),
    pushBitrateInput: $("pushBitrateInput"),
    pushLight: $("pushLight"),
    pushInfo: $("pushInfo"),
    serverInput: $("serverInput"),
    btnSaveServer: $("btnSaveServer"),
    btnResetServer: $("btnResetServer"),
    serverHint: $("serverHint"),
    cloudSelect: $("cloudSelect"),
    camUrls: $("camUrls"),
    cloudTemplateInput: $("cloudTemplateInput"),
    btnSaveCloud: $("btnSaveCloud"),
    btnResetCloud: $("btnResetCloud"),
    cloudHint: $("cloudHint"),
    dmRoomInput: $("dmRoomInput"),
    dmGatewayInput: $("dmGatewayInput"),
    dmCookieInput: $("dmCookieInput"),
    btnDmToggle: $("btnDmToggle"),
    btnDmClear: $("btnDmClear"),
    dmStatus: $("dmStatus"),
    logBox: $("logBox")
  };

  // ---------- 服务器地址：优先使用浏览器里保存的值 ----------
  const SERVER_STORAGE_KEY = "director.serverBase";
  const DEFAULT_SERVER_BASE = CFG.serverBase;

  /** 地址留空表示与页面同源 */
  function describeBase(value) {
    return value === "" ? "与页面同源" : value;
  }

  const savedServerBase = localStorage.getItem(SERVER_STORAGE_KEY);
  if (savedServerBase !== null) CFG.serverBase = savedServerBase;
  ui.serverInput.value = CFG.serverBase;
  ui.serverHint.textContent =
    "当前生效：" + describeBase(CFG.serverBase) + "（默认 " + describeBase(DEFAULT_SERVER_BASE) + "）";

  // ---------- 拉流通道（云）：优先使用浏览器里保存的值 ----------
  // v2：结构由「地址模板 + 每路鉴权串」改为「每路机位各自一条完整拉流地址」，旧存档直接作废
  const CLOUDS_STORAGE_KEY = "director.clouds.v2";
  const ACTIVE_CLOUD_KEY = "director.activeCloud";
  const DEFAULT_CLOUDS = JSON.parse(JSON.stringify(CFG.clouds || []));
  const DEFAULT_ACTIVE_CLOUD = CFG.activeCloud;

  (function restoreClouds() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(CLOUDS_STORAGE_KEY) || "null");
    } catch (e) {
      saved = null;
    }
    // 按 id 合并，避免旧存档盖掉以后新增的内置通道
    if (Array.isArray(saved)) {
      saved.forEach((sc) => {
        const target = getCloudById(CFG, sc.id);
        if (!target) return;
        ["urlTemplate", "sdkUrl", "licenseUrl", "licenseKey",
         "whipPushServer", "whipPushMode"].forEach((k) => {
          if (typeof sc[k] === "string") target[k] = sc[k];
        });
        if (sc.urls && typeof sc.urls === "object") {
          target.urls = Object.assign({}, target.urls, sc.urls);
        }
      });
    }
    const savedActive = localStorage.getItem(ACTIVE_CLOUD_KEY);
    if (savedActive && getCloudById(CFG, savedActive)) CFG.activeCloud = savedActive;
  })();

  (CFG.clouds || []).forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    ui.cloudSelect.appendChild(opt);
  });
  ui.cloudSelect.value = CFG.activeCloud;

  function currentCloud() {
    return getCloudById(CFG, ui.cloudSelect.value) || (CFG.clouds || [])[0] || null;
  }

  /** 按当前通道重建「每路机位拉流地址」输入框 */
  function renderCamUrls(cloud) {
    const urls = cloud.urls || {};
    ui.camUrls.innerHTML = "";
    (CFG.cameras || []).forEach((cam) => {
      const row = document.createElement("div");
      row.className = "cam-row";

      const label = document.createElement("span");
      label.textContent = cam.id;

      const input = document.createElement("input");
      input.type = "text";
      input.dataset.cam = cam.id;
      input.placeholder = "留空则用地址模板";
      input.value = urls[cam.id] || "";

      row.appendChild(label);
      row.appendChild(input);
      ui.camUrls.appendChild(row);
    });
  }

  /** 读取「每路机位拉流地址」输入框，只保留填了的机位 */
  function readCamUrls() {
    const out = {};
    const inputs = ui.camUrls.querySelectorAll("input[data-cam]");
    Array.prototype.forEach.call(inputs, (inp) => {
      const v = inp.value.trim();
      if (v) out[inp.dataset.cam] = v;
    });
    return out;
  }

  function refreshCloudEditor() {
    const c = currentCloud();
    if (!c) {
      ui.cloudHint.textContent = "没有可用的拉流通道";
      return;
    }
    renderCamUrls(c);
    ui.cloudTemplateInput.value = c.urlTemplate || "";
    const total = (CFG.cameras || []).length;
    const filled = (CFG.cameras || [])
      .filter((cam) => ((c.urls || {})[cam.id] || "").trim()).length;
    ui.cloudHint.textContent = "当前生效：" + c.name + "（取流方式 " + c.provider +
      "；已单独填地址 " + filled + "/" + total + " 路，其余走地址模板）";
  }
  refreshCloudEditor();

  /** 把各通道的可编辑字段写入 localStorage */
  function saveClouds() {
    localStorage.setItem(CLOUDS_STORAGE_KEY, JSON.stringify(
      CFG.clouds.map((x) => ({
        id: x.id,
        urlTemplate: x.urlTemplate,
        urls: x.urls,
        sdkUrl: x.sdkUrl,
        licenseUrl: x.licenseUrl,
        licenseKey: x.licenseKey,
        whipPushServer: x.whipPushServer,
        whipPushMode: x.whipPushMode
      }))
    ));
  }

  // ---------- B站弹幕：优先使用浏览器里保存的房间号、网关地址与登录 Cookie ----------
  const DM_ROOM_KEY = "director.danmakuRoom";
  const DM_GATEWAY_KEY = "director.danmakuGateway";
  const DM_COOKIE_KEY = "director.danmakuCookie";
  CFG.danmaku = CFG.danmaku || {};

  const savedDmRoom = localStorage.getItem(DM_ROOM_KEY);
  const savedDmGateway = localStorage.getItem(DM_GATEWAY_KEY);
  const savedDmCookie = localStorage.getItem(DM_COOKIE_KEY);
  if (savedDmRoom !== null) CFG.danmaku.room = savedDmRoom;
  if (savedDmGateway !== null) CFG.danmaku.gatewayUrl = savedDmGateway;
  if (savedDmCookie !== null) CFG.danmaku.cookie = savedDmCookie;
  ui.dmRoomInput.value = CFG.danmaku.room || "";
  ui.dmGatewayInput.value = CFG.danmaku.gatewayUrl || "";
  ui.dmCookieInput.value = CFG.danmaku.cookie || "";

  // 输出画布尺寸由配置决定
  ui.outputCanvas.width = CFG.output.width;
  ui.outputCanvas.height = CFG.output.height;

  function log(message, kind) {
    const line = document.createElement("div");
    if (kind) line.className = "l-" + kind;
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = "[" + t + "] " + message;
    ui.logBox.appendChild(line);
    ui.logBox.scrollTop = ui.logBox.scrollHeight;
  }

  // 环境检查
  if (typeof MediaStreamTrackProcessor === "undefined") {
    log("当前浏览器不支持 WebCodecs / MediaStreamTrackProcessor，无法进行帧级同步，请改用 Chrome / Edge 94+", "error");
  }

  // ---------- 模块实例 ----------
  const compositor = new Compositor(ui.outputCanvas, CFG);

  const mixer = new AudioMixer(CFG);

  const engine = new SyncEngine(CFG, {
    onAudioTrack: (camId, track) => {
      mixer.addTrack(camId, track);
      log("机位 " + camId + " 音频轨已接入混音器", "ok");
    }
  });

  const output = new OutputManager(
    ui.outputCanvas,
    CFG,
    () => mixer.outputTrack,
    (mode, status, info) => {
      ui.outputLight.className = "status-light" +
        (status === "running" ? " on" : status === "error" ? " err" : status === "connecting" ? " warn" : "");
      ui.outputInfo.textContent = info;
      ui.statOutput.textContent = "输出：" + (mode === "off" ? "已关闭" : info);
    },
    (status, info) => {
      ui.pushLight.className = "status-light" +
        (status === "running" ? " on" : status === "error" ? " err" : status === "connecting" ? " warn" : "");
      ui.pushInfo.textContent = info;
    }
  );

  // ---------- 成品回传（WHIP 推腾讯云）：推流地址 / 码率优先用浏览器里保存的值 ----------
  const PUSH_TOKEN_KEY = "director.pushToken";
  CFG.output = CFG.output || {};

  const savedPushToken = localStorage.getItem(PUSH_TOKEN_KEY);
  if (savedPushToken !== null) CFG.output.whipPushToken = savedPushToken;
  ui.pushTokenInput.value = CFG.output.whipPushToken || "";

  // 回传走哪个云：决定用哪个通道的 WHIP 服务地址与推送方式（streamurl / direct）
  const PUSH_CLOUD_KEY = "director.pushCloud";
  const pushClouds = (CFG.clouds || []).filter((c) => !!c.whipPushMode);
  pushClouds.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    ui.pushCloudSelect.appendChild(opt);
  });

  function currentPushCloud() {
    return getCloudById(CFG, ui.pushCloudSelect.value) || pushClouds[0] || null;
  }

  /**
   * 把选中通道的 WHIP 模式同步到 CFG.output，并刷新输入框。
   * 两种模式共用一个输入框：
   *   streamurl（腾讯云）—— 填 pgm 的 WebRTC 推流地址，服务地址用通道里配的固定值
   *   direct（阿里云）    —— 直接填 WHIP 端点（artc 推流地址把协议头换成 https）
   */
  function syncPushCloudToOutput() {
    const c = currentPushCloud();
    if (!c) {
      ui.pushCloudHint.textContent = "没有可用的回传通道";
      return;
    }
    CFG.output.whipPushMode = c.whipPushMode || "streamurl";

    if (CFG.output.whipPushMode === "direct") {
      CFG.output.whipPushServer = c.whipPushServer || "";
      ui.pushTokenInput.placeholder = "https://推流域名/AppName/pgm?auth_key=…（artc 换成 https）";
      ui.pushTokenInput.value = c.whipPushServer || "";
      ui.pushCloudHint.textContent = "当前：" + c.name + "（直接填 WHIP 端点，鉴权已在地址里）";
    } else {
      CFG.output.whipPushServer = c.whipPushServer || "";
      ui.pushTokenInput.placeholder = "webrtc://推流域名/AppName/pgm?txSecret=…（pgm 的推流地址）";
      ui.pushTokenInput.value = CFG.output.whipPushToken || "";
      ui.pushCloudHint.textContent = "当前：" + c.name + "（填 pgm 的 WebRTC 推流地址）";
    }
  }

  const savedPushCloud = localStorage.getItem(PUSH_CLOUD_KEY);
  if (savedPushCloud && getCloudById(CFG, savedPushCloud)) {
    ui.pushCloudSelect.value = savedPushCloud;
  }
  syncPushCloudToOutput();

  ui.pushCloudSelect.addEventListener("change", async () => {
    localStorage.setItem(PUSH_CLOUD_KEY, ui.pushCloudSelect.value);
    syncPushCloudToOutput();
    const c = currentPushCloud();
    log("回传通道已切换为「" + (c ? c.name : "无") + "」，请确认回传地址已填且未过期", "warn");
    if (ui.pushEnabled.checked) {
      await mixer.resume();
      await output.setPushEnabled(true);
    }
  });

  // 回传码率上限（Mbps）：存浏览器里，改完立即重连生效
  const PUSH_BITRATE_KEY = "director.pushBitrateMbps";
  const savedBitrate = parseFloat(localStorage.getItem(PUSH_BITRATE_KEY));
  if (!isNaN(savedBitrate) && savedBitrate > 0) {
    CFG.output.pushMaxBitrate = Math.round(savedBitrate * 1e6);
  }
  ui.pushBitrateInput.value = String(CFG.output.pushMaxBitrate / 1e6);

  // 回传开关默认关闭：每次都需手动开启（推流地址带有效期，自动恢复没有意义）
  ui.pushEnabled.checked = false;

  ui.pushEnabled.addEventListener("change", async () => {
    await mixer.resume();
    const on = ui.pushEnabled.checked;
    CFG.output.whipPushToken = ui.pushTokenInput.value.trim();
    localStorage.setItem(PUSH_TOKEN_KEY, CFG.output.whipPushToken);
    log(on ? "开启成品回传（WHIP）…" : "关闭成品回传");
    await output.setPushEnabled(on);
  });

  ui.pushTokenInput.addEventListener("change", async () => {
    const c = currentPushCloud();
    const value = ui.pushTokenInput.value.trim();
    if (c && c.whipPushMode === "direct") {
      // direct 模式：输入框装的是 WHIP 端点，存到该通道上
      c.whipPushServer = value;
      CFG.output.whipPushServer = value;
      saveClouds();
      log("已保存 WHIP 端点");
    } else {
      CFG.output.whipPushToken = value;
      localStorage.setItem(PUSH_TOKEN_KEY, value);
      log("已保存 WHIP 推流地址");
    }
    // 回传已开启时，用新地址重连一次，避免继续沿用旧的（可能已过期的）地址
    if (ui.pushEnabled.checked) {
      await mixer.resume();
      await output.setPushEnabled(true);
    }
  });

  ui.pushBitrateInput.addEventListener("change", async () => {
    const mbps = parseFloat(ui.pushBitrateInput.value);
    if (isNaN(mbps) || mbps <= 0) {
      ui.pushBitrateInput.value = String(CFG.output.pushMaxBitrate / 1e6);
      log("码率请输入大于 0 的数字（单位 Mbps）", "error");
      return;
    }
    CFG.output.pushMaxBitrate = Math.round(mbps * 1e6);
    localStorage.setItem(PUSH_BITRATE_KEY, String(mbps));
    log("回传码率上限已设为 " + mbps + " Mbps");
    // 回传已开启时立即用新码率重连
    if (ui.pushEnabled.checked) {
      await mixer.resume();
      await output.setPushEnabled(true);
    }
  });

  // ---------- 机位实时码率 ----------
  // 播放器（TCPlayer 等）内部的 RTCPeerConnection 拿不到引用，这里统一拦截构造函数，
  // 之后按「视频轨道」反查所属连接，读取 inbound-rtp 的字节数换算出每路实时码率。
  const trackedPcs = [];
  (function trackPeerConnections() {
    const OrigPC = window.RTCPeerConnection;
    if (!OrigPC) return;
    class TrackedRTCPeerConnection extends OrigPC {
      constructor(...args) {
        super(...args);
        trackedPcs.push(this);
      }
    }
    window.RTCPeerConnection = TrackedRTCPeerConnection;
  })();

  function findPcForTrack(track) {
    for (let i = trackedPcs.length - 1; i >= 0; i--) {
      const pc = trackedPcs[i];
      try {
        if (pc.getReceivers().some((r) => r.track === track)) return pc;
      } catch (e) { /* 连接可能已关闭 */ }
    }
    return null;
  }

  const camStats = new Map();

  async function sampleCameraBitrates() {
    for (const cam of engine.cameraList) {
      const track = cam.videoTrack;
      if (!track) {
        camStats.delete(cam.id);
        cam.kbps = 0;
        continue;
      }

      let st = camStats.get(cam.id);
      if (!st || !st.pc || st.pc.connectionState === "closed") {
        const pc = findPcForTrack(track);
        if (!pc) continue;
        st = { pc: pc, lastBytes: 0, lastTs: 0, kbps: 0 };
        camStats.set(cam.id, st);
      }

      try {
        const report = await st.pc.getStats();
        let bytes = 0;
        report.forEach((s) => {
          if (s.type === "inbound-rtp" && (s.kind === "video" || s.mediaType === "video")) {
            bytes += s.bytesReceived || 0;
          }
        });
        const now = performance.now();
        if (st.lastTs && now > st.lastTs && bytes >= st.lastBytes) {
          st.kbps = Math.round(((bytes - st.lastBytes) * 8) / (now - st.lastTs));
        }
        st.lastBytes = bytes;
        st.lastTs = now;
        cam.kbps = st.kbps;
      } catch (e) { /* 统计失败不影响播放 */ }
    }
  }
  setInterval(sampleCameraBitrates, 1000);

  // 每路时间戳偏移仍由 config.timestampOffsetMs 提供（默认全 0；确需微调可直接改 config）
  CFG.timestampOffsetMs = CFG.timestampOffsetMs || {};

  // ---------- 同步延迟：自动补偿上限 + 额外手动延迟 ----------
  const SYNC_MAX_DELAY_KEY = "director.syncMaxDelayMs";
  const SYNC_EXTRA_DELAY_KEY = "director.syncExtraDelayMs";

  const savedMaxDelay = parseFloat(localStorage.getItem(SYNC_MAX_DELAY_KEY));
  if (!isNaN(savedMaxDelay) && savedMaxDelay >= 0) CFG.syncMaxDelayMs = savedMaxDelay;
  const savedExtraDelay = parseFloat(localStorage.getItem(SYNC_EXTRA_DELAY_KEY));
  if (!isNaN(savedExtraDelay) && savedExtraDelay >= 0) CFG.syncExtraDelayMs = savedExtraDelay;

  ui.syncMaxDelayInput.value = String(CFG.syncMaxDelayMs);
  ui.syncExtraDelayInput.value = String(CFG.syncExtraDelayMs);

  ui.syncMaxDelayInput.addEventListener("change", () => {
    const v = parseFloat(ui.syncMaxDelayInput.value);
    if (isNaN(v) || v < 0) {
      ui.syncMaxDelayInput.value = String(CFG.syncMaxDelayMs);
      log("自动补偿请输入不小于 0 的毫秒数", "error");
      return;
    }
    CFG.syncMaxDelayMs = v;
    localStorage.setItem(SYNC_MAX_DELAY_KEY, String(v));
    log(v > 0
      ? "自动同步补偿上限已设为 " + v + " ms（标尺最多退到最慢那一路）"
      : "已关闭自动同步补偿（跟随基准机位最新帧）");
  });

  ui.syncExtraDelayInput.addEventListener("change", () => {
    const v = parseFloat(ui.syncExtraDelayInput.value);
    if (isNaN(v) || v < 0) {
      ui.syncExtraDelayInput.value = String(CFG.syncExtraDelayMs);
      log("额外延迟请输入不小于 0 的毫秒数", "error");
      return;
    }
    CFG.syncExtraDelayMs = v;
    localStorage.setItem(SYNC_EXTRA_DELAY_KEY, String(v));
    log("额外同步延迟已设为 " + v + " ms");
  });

  // 每秒刷新「当前同步延迟」读数
  setInterval(() => {
    ui.syncDelayInfo.textContent = "当前同步延迟：" + Math.round(engine.currentDelayMs || 0) + " ms";
  }, 1000);

  // ---------- 连接信息自动跑马灯：文字溢出时循环滚动，到端点停顿后回卷 ----------
  const DM_MARQUEE_STEP = 1;       // 每次移动的像素
  const DM_MARQUEE_INTERVAL = 40;  // 毫秒
  const DM_MARQUEE_PAUSE = 30;     // 到端点后停顿的 tick 数（≈1.2 秒）
  let marqueePause = 0;
  let lastStatusText = "";

  setInterval(() => {
    const el = ui.dmStatus;
    if (!el) return;

    // 文案变化（连接中/已连接/已断开…）时从头开始
    if (el.textContent !== lastStatusText) {
      lastStatusText = el.textContent;
      el.scrollLeft = 0;
      marqueePause = 0;
      return;
    }

    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0) {
      el.scrollLeft = 0;
      return;
    }
    if (marqueePause > 0) {
      marqueePause--;
      return;
    }

    el.scrollLeft += DM_MARQUEE_STEP;
    if (el.scrollLeft >= overflow) {
      el.scrollLeft = 0; // 回卷重新开始
      marqueePause = DM_MARQUEE_PAUSE;
    }
  }, DM_MARQUEE_INTERVAL);

  const danmaku = new DanmakuPanel(CFG.danmaku, { onLog: log });

  const loggedErrors = new Set();
  engine.onChange = () => {
    for (const cam of engine.cameraList) {
      if (cam.state === "error" && !loggedErrors.has(cam.id)) {
        loggedErrors.add(cam.id);
        log(cam.name + "：" + cam.errorMessage, "error");
      }
      if (cam.state === "live" && loggedErrors.has(cam.id)) {
        loggedErrors.delete(cam.id);
      }
    }
  };

  // ---------- 导播状态 ----------
  let programId = engine.referenceId;
  let pipId = CFG.cameras.length > 1 ? CFG.cameras[1].id : null;

  // ---------- 构建多机位监看 ----------
  const tiles = new Map();
  for (const def of CFG.cameras) {
    const tile = document.createElement("div");
    tile.className = "tile";

    const cv = document.createElement("canvas");
    cv.width = 480;
    cv.height = 270;

    const bar = document.createElement("div");
    bar.className = "tile-bar";

    const nameEl = document.createElement("span");
    nameEl.className = "tile-name";
    nameEl.textContent = def.name || def.id;

    const rightEl = document.createElement("span");
    rightEl.className = "tile-right";

    const stateEl = document.createElement("span");
    stateEl.className = "tile-state";
    stateEl.textContent = "未连接";

    // 单路音量条（实时监看）
    const meter = document.createElement("div");
    meter.className = "tile-meter";
    const meterFill = document.createElement("div");
    meterFill.className = "tile-meter-fill";
    meter.appendChild(meterFill);

    // 单路连接 / 断开按钮
    const connBtn = document.createElement("button");
    connBtn.className = "tile-btn";
    connBtn.textContent = "连接";
    connBtn.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 避免连带触发「切换为 PGM」
      toggleCamera(def.id);
    });

    rightEl.appendChild(stateEl);
    rightEl.appendChild(connBtn);
    bar.appendChild(nameEl);
    bar.appendChild(meter);
    bar.appendChild(rightEl);

    tile.appendChild(cv);
    tile.appendChild(bar);
    tile.addEventListener("click", () => selectProgram(def.id));

    ui.multiviewGrid.appendChild(tile);
    tiles.set(def.id, {
      tile, canvas: cv, ctx: cv.getContext("2d"),
      stateEl, connBtn, meterFill,
      peak: 0, peakTs: 0
    });
  }

  // ---------- 构建 PGM 切换按钮 ----------
  const pgmButtons = new Map();
  for (const def of CFG.cameras) {
    const btn = document.createElement("button");
    btn.className = "btn cam-btn";
    btn.textContent = def.name || def.id;
    btn.addEventListener("click", () => selectProgram(def.id));
    ui.pgmButtons.appendChild(btn);
    pgmButtons.set(def.id, btn);
  }

  // ---------- 构建画中画下拉 ----------
  for (const def of CFG.cameras) {
    const opt = document.createElement("option");
    opt.value = def.id;
    opt.textContent = def.name || def.id;
    ui.pipSelect.appendChild(opt);
  }
  if (pipId) ui.pipSelect.value = pipId;

  // ---------- 构建音频控制行 ----------
  for (const def of CFG.cameras) {
    const row = document.createElement("div");
    row.className = "audio-row";

    const name = document.createElement("span");
    name.className = "mini";
    name.textContent = def.name || def.id;

    const vol = document.createElement("input");
    vol.type = "range";
    vol.min = "0";
    vol.max = "100";
    vol.value = "100";
    vol.addEventListener("input", () => mixer.setVolume(def.id, vol.value / 100));

    let muted = false;
    const muteBtn = document.createElement("button");
    muteBtn.className = "btn small";
    muteBtn.textContent = "静音";
    muteBtn.addEventListener("click", () => {
      muted = !muted;
      mixer.setMuted(def.id, muted);
      muteBtn.textContent = muted ? "取消静音" : "静音";
      muteBtn.classList.toggle("danger", muted);
    });

    row.appendChild(name);
    row.appendChild(vol);
    row.appendChild(muteBtn);
    ui.audioList.appendChild(row);
  }

  // ---------- 机位切换 ----------
  function selectProgram(id) {
    if (!engine.cameras.has(id)) return;
    programId = id;
    compositor.setProgram(id);

    pgmButtons.forEach((btn, cid) => btn.classList.toggle("active", cid === id));
    tiles.forEach((t, cid) => t.tile.classList.toggle("pgm", cid === id));

    const cam = engine.cameras.get(id);
    ui.programBadge.textContent = "PGM：" + (cam ? cam.name : id);
  }

  // ---------- 单路机位连接 / 断开 ----------
  async function connectCamera(id) {
    const cam = engine.cameras.get(id);
    if (!cam || cam.isActive) return;
    await mixer.resume();
    log("连接 " + cam.name + " …");
    await cam.connect();
    if (cam.state === "live") log(cam.name + " 已连接", "ok");
  }

  function disconnectCamera(id) {
    const cam = engine.cameras.get(id);
    if (!cam) return;
    cam.disconnect();
    mixer.removeChannel(id);
    log(cam.name + " 已断开", "warn");
  }

  /** 连接中 ↔ 已连接 都视为「活动中」，此时按钮为断开/取消 */
  function toggleCamera(id) {
    const cam = engine.cameras.get(id);
    if (!cam) return;
    if (cam.isActive) disconnectCamera(id);
    else connectCamera(id);
  }

  // ---------- 控件绑定 ----------
  ui.btnConnect.addEventListener("click", async () => {
    ui.btnConnect.disabled = true;
    log("开始连接全部机位…");
    await mixer.resume();
    await engine.connectAll();
    const live = engine.cameraList.filter((c) => c.state === "live").length;
    log("连接流程结束，" + live + "/" + engine.cameraList.length + " 路机位在线", live ? "ok" : "error");
    ui.btnConnect.disabled = false;
    ui.btnDisconnect.disabled = false;
  });

  ui.btnDisconnect.addEventListener("click", async () => {
    engine.disconnectAll();
    CFG.cameras.forEach((def) => mixer.removeChannel(def.id));
    await output.setOutputMode("off");
    ui.outputSelect.value = "off";
    ui.btnDisconnect.disabled = true;
    ui.btnConnect.disabled = false;
    loggedErrors.clear();
    log("已断开全部机位并关闭输出", "warn");
  });

  ui.pipEnabled.addEventListener("change", () => {
    compositor.setPip(ui.pipEnabled.checked ? pipId : null);
  });

  ui.pipSelect.addEventListener("change", () => {
    pipId = ui.pipSelect.value;
    if (ui.pipEnabled.checked) compositor.setPip(pipId);
  });

  ui.transRange.addEventListener("input", () => {
    const ms = Number(ui.transRange.value);
    compositor.setTransitionMs(ms);
    ui.transVal.textContent = ms + " ms";
  });

  ui.logoInput.addEventListener("change", () => {
    const file = ui.logoInput.files && ui.logoInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        compositor.setLogo(img);
        log("台标已加载：" + file.name, "ok");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  ui.btnClearLogo.addEventListener("click", () => {
    compositor.setLogo(null);
    ui.logoInput.value = "";
    log("台标已清除");
  });

  // ---------- 台标大小（占成品画面宽度比例，实时生效并存浏览器） ----------
  const LOGO_SIZE_KEY = "director.logoWidthScale";

  const savedLogoSize = parseFloat(localStorage.getItem(LOGO_SIZE_KEY));
  if (!isNaN(savedLogoSize) && savedLogoSize > 0) CFG.logoWidthScale = savedLogoSize;

  // 把比例换算成实际像素显示，便于对齐视觉大小
  function syncLogoSizeLabel() {
    const w = CFG.output.width;
    ui.logoSizeVal.textContent =
      (CFG.logoWidthScale * 100).toFixed(1) + "% · " + Math.round(w * CFG.logoWidthScale) + "px";
  }

  ui.logoSizeRange.value = String(Math.round(CFG.logoWidthScale * 100));
  compositor.setLogoWidthScale(CFG.logoWidthScale);
  syncLogoSizeLabel();

  ui.logoSizeRange.addEventListener("input", () => {
    CFG.logoWidthScale = Number(ui.logoSizeRange.value) / 100;
    compositor.setLogoWidthScale(CFG.logoWidthScale);
    localStorage.setItem(LOGO_SIZE_KEY, String(CFG.logoWidthScale));
    syncLogoSizeLabel();
  });

  ui.masterVol.addEventListener("input", () => {
    mixer.setMaster(Number(ui.masterVol.value) / 100);
  });

  ui.monitorChk.addEventListener("change", async () => {
    // 浏览器要求先有用户手势才能出声，否则监听打开了也没声音
    await mixer.resume();
    mixer.setMonitor(ui.monitorChk.checked);
  });

  ui.outputSelect.addEventListener("change", async () => {
    await mixer.resume();
    log("切换输出模式：" + ui.outputSelect.value);
    await output.setOutputMode(ui.outputSelect.value);
  });

  // ---------- B站弹幕 ----------
  ui.btnDmToggle.addEventListener("click", () => {
    if (danmaku.closedByUser) {
      const room = ui.dmRoomInput.value.trim();
      if (!room) {
        log("请先填写 B站直播间号", "error");
        return;
      }
      const gateway = ui.dmGatewayInput.value.trim();
      const cookie = ui.dmCookieInput.value.trim();
      CFG.danmaku.room = room;
      CFG.danmaku.gatewayUrl = gateway;
      CFG.danmaku.cookie = cookie;
      localStorage.setItem(DM_ROOM_KEY, room);
      localStorage.setItem(DM_GATEWAY_KEY, gateway);
      localStorage.setItem(DM_COOKIE_KEY, cookie);

      if (danmaku.connect(room, cookie)) ui.btnDmToggle.textContent = "断开";
    } else {
      danmaku.disconnect();
      ui.btnDmToggle.textContent = "连接";
    }
  });

  ui.btnDmClear.addEventListener("click", () => danmaku.clear());

  // ---------- 拉流通道（云）设置 ----------
  /** 断开全部机位与输出，供切换配置后调用 */
  async function resetAllConnections() {
    engine.disconnectAll();
    CFG.cameras.forEach((def) => mixer.removeChannel(def.id));
    await output.setOutputMode("off");
    ui.outputSelect.value = "off";
    ui.btnDisconnect.disabled = true;
    ui.btnConnect.disabled = false;
    loggedErrors.clear();
  }

  ui.cloudSelect.addEventListener("change", refreshCloudEditor);

  ui.btnSaveCloud.addEventListener("click", async () => {
    const c = currentCloud();
    if (!c) return;

    const tpl = ui.cloudTemplateInput.value.trim();
    const urls = readCamUrls();

    // 一路地址都没填时，必须有模板兜底，否则连不上
    if (!tpl && !Object.keys(urls).length) {
      log("请至少填一路机位拉流地址，或填一个地址模板", "error");
      return;
    }

    c.urlTemplate = tpl;
    c.urls = urls;
    CFG.activeCloud = c.id;
    localStorage.setItem(ACTIVE_CLOUD_KEY, c.id);
    saveClouds();

    await resetAllConnections();
    refreshCloudEditor();

    log("拉流通道已切换为「" + c.name + "」（单独填地址 " + Object.keys(urls).length +
      " 路），请重新点击「连接全部机位」", "ok");
  });

  ui.btnResetCloud.addEventListener("click", () => {
    localStorage.removeItem(CLOUDS_STORAGE_KEY);
    localStorage.removeItem(ACTIVE_CLOUD_KEY);
    CFG.clouds = JSON.parse(JSON.stringify(DEFAULT_CLOUDS));
    CFG.activeCloud = DEFAULT_ACTIVE_CLOUD;
    ui.cloudSelect.value = CFG.activeCloud;
    refreshCloudEditor();
    log("拉流通道已恢复为默认配置", "warn");
  });

  // ---------- 成品输出服务器 ----------
  ui.btnSaveServer.addEventListener("click", async () => {
    const value = ui.serverInput.value.trim().replace(/\/+$/, "");
    // 允许留空：表示与导播页面同源（页面部署在 ZLMediaKit 的 www 目录时用这种写法）
    if (value !== "" && !/^https?:\/\//i.test(value)) {
      log("服务器地址需以 http:// 或 https:// 开头；若与页面同源可留空", "error");
      return;
    }

    CFG.serverBase = value;
    localStorage.setItem(SERVER_STORAGE_KEY, value);
    ui.serverInput.value = value;
    ui.serverHint.textContent =
      "当前生效：" + describeBase(value) + "（默认 " + describeBase(DEFAULT_SERVER_BASE) + "）";

    // 断开旧连接，避免继续指向上一台服务器
    engine.disconnectAll();
    await output.setOutputMode("off");
    ui.outputSelect.value = "off";
    ui.btnDisconnect.disabled = true;
    ui.btnConnect.disabled = false;
    loggedErrors.clear();

    log("服务器地址已更新为 " + describeBase(value) + "，请重新点击「连接全部机位」", "ok");
  });

  ui.btnResetServer.addEventListener("click", () => {
    localStorage.removeItem(SERVER_STORAGE_KEY);
    CFG.serverBase = DEFAULT_SERVER_BASE;
    ui.serverInput.value = DEFAULT_SERVER_BASE;
    ui.serverHint.textContent = "当前生效：" + describeBase(DEFAULT_SERVER_BASE) + "（默认值）";
    log("已恢复默认服务器地址：" + describeBase(DEFAULT_SERVER_BASE), "warn");
  });

  // ---------- 渲染主循环 ----------
  let fpsFrames = 0;
  let fpsLast = performance.now();
  let hasFrame = false;
  // 渲染帧率上限：避免高刷屏 / 无头环境下空转浪费 CPU
  const frameInterval = CFG.renderFpsLimit > 0 ? 1000 / CFG.renderFpsLimit : 0;
  let lastRenderTs = -frameInterval;

  function drawTile(entry, cam, isRef, syncFrame) {
    const ctx = entry.ctx;
    const W = entry.canvas.width;
    const H = entry.canvas.height;

    ctx.fillStyle = isRef ? "#0e1a12" : "#0a0c10";
    ctx.fillRect(0, 0, W, H);

    // 优先用与成品同一时刻的对齐帧；该路没有落在容差内的帧时退回最新帧
    const frame = syncFrame || cam.buffer.latest;
    if (frame) {
      try { drawFit(ctx, frame, 0, 0, W, H); } catch (e) { /* 帧可能已释放 */ }
    }

    entry.tile.classList.toggle("ref", isRef);
    entry.tile.classList.toggle("live", cam.state === "live");
    entry.tile.classList.toggle("error", cam.state === "error");
    entry.stateEl.textContent = camStatusText(cam);
    updateTileButton(entry.connBtn, cam);
  }

  /** 根据机位状态刷新单路按钮文案（连接 / 取消 / 断开） */
  function updateTileButton(btn, cam) {
    let label = "连接";
    if (cam.state === "connecting") label = "取消";
    else if (cam.state === "live") label = "断开";

    if (btn.textContent !== label) btn.textContent = label;
    btn.classList.toggle("is-disconnect", cam.isActive);
  }

  /** 码率显示：>=1000 kbps 时换算成 Mbps */
  function formatBitrate(kbps) {
    return kbps >= 1000 ? (kbps / 1000).toFixed(2) + " Mbps" : kbps + " kbps";
  }

  function camStatusText(cam) {
    switch (cam.state) {
      case "idle": return "未连接";
      case "connecting": return "连接中…";
      case "live":
        return "缓冲 " + cam.buffer.length + " 帧" +
          (cam.kbps ? " · " + formatBitrate(cam.kbps) : "");
      case "error": return "错误";
      case "closed": return "已断开";
      default: return cam.state;
    }
  }

  /** 峰值保持衰减：超过该时间后峰值开始回落（毫秒） */
  const METER_PEAK_HOLD_MS = 250;
  const METER_PEAK_DECAY_PER_MS = 0.0015;

  /** 更新每路机位的音量条：实时 RMS + 峰值保持，视觉更跟手 */
  function updateMeters(now) {
    tiles.forEach((entry, id) => {
      const level = mixer.getLevel(id);
      let peak = entry.peak;
      if (level >= peak) {
        peak = level;
        entry.peakTs = now;
      } else if (now - entry.peakTs > METER_PEAK_HOLD_MS) {
        peak = Math.max(level, peak - (now - entry.peakTs) * METER_PEAK_DECAY_PER_MS);
      }
      entry.peak = peak;
      entry.meterFill.style.width = (peak * 100).toFixed(1) + "%";
    });
  }

  function renderFrame(now) {
    // 帧率上限：未到下一帧时间则直接返回，画面不重绘。
    // 用取模对齐相位，使 75/120/144/240Hz 等刷新率也能稳定落在目标帧率上，
    // 而不是简单丢弃导致掉到 37 / 48 fps。
    if (frameInterval) {
      const elapsed = now - lastRenderTs;
      if (elapsed < frameInterval) return;
      lastRenderTs = now - (elapsed % frameInterval);
    }

    const syncResult = engine.tick();
    compositor.render(syncResult, now);

    if (syncResult && !hasFrame) {
      hasFrame = true;
      ui.outputPlaceholder.style.display = "none";
      log("已收到基准机位画面，开始帧同步合成", "ok");
    }

    // 多机位监看：与成品用同一批「同一时刻」的对齐帧，保证各格画面同步
    const syncFrames = syncResult ? syncResult.frames : null;
    tiles.forEach((entry, id) => {
      drawTile(entry, engine.cameras.get(id), id === engine.referenceId,
        syncFrames ? syncFrames.get(id) : null);
    });

    updateMeters(now);

    fpsFrames++;
    if (now - fpsLast >= 1000) {
      const fps = (fpsFrames * 1000) / (now - fpsLast);
      ui.statFps.textContent = "渲染 FPS：" + fps.toFixed(1);
      fpsFrames = 0;
      fpsLast = now;
    }
  }

  /** 可见时由浏览器通过 requestAnimationFrame 驱动 */
  let lastRafTs = performance.now();

  function loop(now) {
    lastRafTs = performance.now();
    requestAnimationFrame(loop);
    renderFrame(now);
  }

  /**
   * 页面被切到后台、最小化或被其他窗口遮挡时，浏览器会暂停 requestAnimationFrame，
   * 导致成品画布不再重绘、推流画面“冻住”。这里用看门狗监测 rAF 是否还在跑：
   * 一旦停摆就改用定时器兜底渲染，保证输出连续（帧率会受浏览器后台限流影响）。
   * 想要后台也满帧运行，可用启动参数：
   *   --disable-background-timer-throttling --disable-backgrounding-occluded-windows
   *   --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion
   */
  let bgRenderTimer = null;
  setInterval(function () {
    const stalled = performance.now() - lastRafTs > 700;
    if (stalled && !bgRenderTimer) {
      bgRenderTimer = setInterval(function () { renderFrame(performance.now()); }, 66);
    } else if (!stalled && bgRenderTimer) {
      clearInterval(bgRenderTimer);
      bgRenderTimer = null;
    }
  }, 500);

  // ---------- 初始化 ----------
  const refCam = engine.reference;
  ui.statRef.textContent = "基准机位：" + (refCam ? refCam.name : "-");
  ui.outputHint.textContent =
    "提示：本机开发建议用 Chrome / Edge 打开；公网访问必须 HTTPS，否则浏览器会禁用 WebRTC。";
  selectProgram(programId);
  log("导播台已就绪，拉流通道「" + (currentCloud() ? currentCloud().name : "无") +
    "」，成品输出服务器 " + describeBase(CFG.serverBase) + "，点击「连接全部机位」开始拉流");

  // 若配置里已有直播间号，自动订阅
  if (CFG.danmaku.room) {
    ui.btnDmToggle.textContent = "断开";
    danmaku.connect(CFG.danmaku.room, CFG.danmaku.cookie);
  }

  requestAnimationFrame(loop);
})();
