/**
 * 统一输出管理器
 * 成品画布采集后交给两条互不影响的链路：
 *   输出模式 —— off / virtualcam：把画布流暴露到 window.directorOutputStream，
 *               交由本机虚拟摄像头驱动或 OBS「浏览器源」接管；
 *   成品回传 —— 独立开关：把画布流 WHIP 推到腾讯云快直播，落地后由 pgm.html 用
 *               快直播 WebRTC 拉流观看（流名 pgm）。浏览器不能推/拉 RTMP，故回传走 WHIP。
 */
class OutputManager {
  /**
   * @param {HTMLCanvasElement} canvas 成品输出画布
   * @param {object} config 全局配置
   * @param {() => (MediaStreamTrack|null)} getAudioTrack 取混音后的音频轨
   * @param {(mode: string, status: string, info: string) => void} onState 输出模式状态回调
   * @param {(status: string, info: string) => void} [onPushState] 成品回传状态回调
   */
  constructor(canvas, config, getAudioTrack, onState, onPushState) {
    this.canvas = canvas;
    this.config = config;
    this.getAudioTrack = getAudioTrack;
    this.onState = onState || function () {};
    this.onPushState = onPushState || function () {};

    /** off | virtualcam */
    this.mode = "off";
    /** idle | connecting | running | error */
    this.status = "idle";
    this.info = "未启用";

    this.stream = null;
    this.pc = null;

    /** 成品回传（WHIP 推腾讯云）状态，与输出模式相互独立，可同时开启 */
    this.pushEnabled = false;
    this.pushPc = null;
    this.pushStream = null;
    this.pushStatus = "idle";
    this.pushInfo = "未启用";
    /** 连接尝试代号：每次重建都自增，用于丢弃过期（已被替换）的结果 */
    this._pushGen = 0;
  }

  _emit() {
    this.onState(this.mode, this.status, this.info);
  }

  _emitPush() {
    this.onPushState(this.pushStatus, this.pushInfo);
  }

  /** 画布流只采集一次 */
  getOutputStream() {
    if (this.stream) return this.stream;

    const stream = this.canvas.captureStream(this.config.output.fps);
    const audioTrack = this.getAudioTrack ? this.getAudioTrack() : null;
    if (audioTrack) stream.addTrack(audioTrack);

    this.stream = stream;
    return stream;
  }

  /** 释放当前输出资源；音频轨来自混音器，不能 stop，仅从流中移除 */
  _releaseOutput() {
    if (this.pc) {
      try { this.pc.close(); } catch (e) { /* ignore */ }
      this.pc = null;
    }
    if (this.stream) {
      this.stream.getVideoTracks().forEach((track) => {
        try { track.stop(); } catch (e) { /* ignore */ }
      });
      this.stream = null;
    }
  }

  /**
   * 切换输出模式
   * @param {"off"|"virtualcam"} mode
   */
  async setOutputMode(mode) {
    this._releaseOutput();
    this.mode = mode;

    if (mode === "off") {
      this.status = "idle";
      this.info = "未启用";
      if (window.directorOutputStream) window.directorOutputStream = null;
      this._emit();
      return;
    }

    const stream = this.getOutputStream();

    if (mode === "virtualcam") {
      // 浏览器无法直接向系统虚拟摄像头写入，这里把画布流暴露出去，
      // 由本机虚拟摄像头驱动 / 辅助程序读取，或在 OBS 中用「浏览器源」直接采集本页面。
      window.directorOutputStream = stream;
      this.status = "running";
      this.info =
        "画布流已就绪：OBS 可用「浏览器源」采集本页面，或由虚拟摄像头驱动读取 window.directorOutputStream";
      this._emit();
    }
  }

  // ---------- 成品回传：WHIP 推腾讯云 ----------

  /** 开关成品回传 */
  async setPushEnabled(enabled) {
    this.pushEnabled = !!enabled;
    if (this.pushEnabled) {
      await this._startWhipPush();
      return;
    }
    this._pushGen++; // 作废仍在途的连接尝试
    this._stopWhipPush();
    this.pushStatus = "idle";
    this.pushInfo = "未启用";
    this._emitPush();
  }

  _stopWhipPush() {
    if (this.pushPc) {
      try { this.pushPc.close(); } catch (e) { /* ignore */ }
      this.pushPc = null;
    }
    if (this.pushStream) {
      this.pushStream.getVideoTracks().forEach((t) => {
        try { t.stop(); } catch (e) { /* ignore */ }
      });
      this.pushStream = null;
    }
  }

  async _startWhipPush() {
    const out = this.config.output;

    if (!out.whipPushServer) {
      this.pushStatus = "error";
      this.pushInfo = "回传失败：未配置 WHIP 推流服务地址";
      this._emitPush();
      return;
    }
    if (!out.whipPushToken) {
      this.pushStatus = "error";
      this.pushInfo = "回传失败：请先填写腾讯云 WebRTC 推流地址（Bearer Token）";
      this._emitPush();
      return;
    }

    const gen = ++this._pushGen; // 本次连接代号
    this._stopWhipPush();
    this.pushStatus = "connecting";
    this.pushInfo = "正在建立 WHIP 回传…";
    this._emitPush();

    // 回传单独采一路画布流，和「输出模式」互不干扰，可同时使用
    const pushFps = Math.min(out.fps, out.pushFps || out.fps);
    const stream = this.canvas.captureStream(pushFps);
    const audioTrack = this.getAudioTrack ? this.getAudioTrack() : null;
    if (audioTrack) stream.addTrack(audioTrack);
    this.pushStream = stream;

    try {
      await this._pushWhip(stream);
      if (gen !== this._pushGen) return; // 已被更新的连接取代，丢弃本次结果
      this.pushStatus = "running";
      this.pushInfo = "回传中（流名 " + out.streamName + "）；观看/OBS 浏览器源可用 " +
        window.location.origin + "/pgm.html";
    } catch (err) {
      if (gen !== this._pushGen) return;
      this._stopWhipPush();
      this.pushStatus = "error";
      let msg = err && err.message ? err.message : String(err);
      // 腾讯云 -12：推流地址鉴权失败，最常见于地址已过期
      if (msg.indexOf('"errcode":-12') >= 0) {
        msg += "（推流地址鉴权失败：多半是地址已过期，请到控制台重新生成）";
      }
      this.pushInfo = "回传失败：" + msg;
    }
    this._emitPush();
  }

  async _pushWhip(stream) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pushPc = pc;

    let videoSender = null;
    stream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, stream);
      if (track.kind === "video") videoSender = sender;
    });

    pc.onconnectionstatechange = () => {
      if (this.pushPc !== pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.pushStatus = "error";
        this.pushInfo = "回传连接中断：" + pc.connectionState;
        this._emitPush();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc, 2000);

    // 腾讯云 WHIP 服务器只允许 content-type 一个请求头（Access-Control-Allow-Headers 里没有
    // authorization），用 Authorization: Bearer 会触发跨域预检失败（浏览器报 Failed to fetch）。
    // 因此把推流地址作为 streamurl 查询参数传递，预检只需放行 content-type 即可通过。
    const server = this.config.output.whipPushServer;
    const url = server + (server.indexOf("?") >= 0 ? "&" : "?") +
      "streamurl=" + encodeURIComponent(this.config.output.whipPushToken);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        "Accept": "application/sdp"
      },
      body: pc.localDescription.sdp
    });
    if (!resp.ok) throw new Error(await describeHttpError(resp));

    const body = await resp.text();
    // 期间可能已被新的连接 / 关闭操作替换（pc 已 closed），直接丢弃本次结果
    if (this.pushPc !== pc || pc.signalingState === "closed") return;

    const answer = parseSdpAnswer(body);
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    // 限制发送码率上限：上行带宽不足时拥塞控制会把视频压得很低（表现为画面卡、声音正常）
    const cap = this.config.output.pushMaxBitrate;
    if (cap && videoSender) {
      try {
        const params = videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = cap;
        await videoSender.setParameters(params);
      } catch (e) { /* 部分浏览器不支持 setParameters，忽略 */ }
    }
  }

  /** 一键关闭全部输出 */
  async shutdown() {
    this.pushEnabled = false;
    this._pushGen++;
    this.pushStatus = "idle";
    this.pushInfo = "未启用";
    this._stopWhipPush();
    this._emitPush();
    await this.setOutputMode("off");
  }
}
