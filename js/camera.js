/**
 * 机位源（CameraSource）
 * 一路机位 = 一路 WHEP 连接 + 一条视频帧读取循环 + 一个帧缓冲队列。
 * 视频帧通过 MediaStreamTrackProcessor 以原始 VideoFrame 形式读出，绕过 <video> 标签的独立解码缓冲。
 */
class CameraSource {
  /**
   * @param {{id: string, name: string}} def 机位定义
   * @param {object} config 全局配置
   */
  constructor(def, config) {
    this.id = def.id;
    this.name = def.name || def.id;
    this.config = config;

    /** idle | connecting | live | error | closed */
    this.state = "idle";
    this.errorMessage = "";

    this.videoTrack = null;
    this.audioTrack = null;
    this.buffer = new FrameBuffer(config.maxBufferFrames);

    this.provider = null;
    this.reader = null;

    /** 连接代次：每次连接/断开自增，用于丢弃已被取消的连接结果 */
    this.connectionGen = 0;

    this.decodedFrames = 0;

    /** 由 SyncEngine 注入 */
    this.onAudioTrack = null;
    this.onStateChange = null;
  }

  /** 是否正处于「已连接」或「连接中」的状态 */
  get isActive() {
    return this.state === "connecting" || this.state === "live";
  }

  async connect() {
    // 清理上一次可能残留的连接，保证可以反复连接
    this._cleanup();
    const gen = ++this.connectionGen;

    this.state = "connecting";
    this.errorMessage = "";

    // 每次连接都重新解析当前生效的拉流通道，切换云后在重连时立即生效
    const cloud = getActiveCloud(this.config);

    try {
      this.provider = createStreamProvider(cloud, this.id, this.config, {
        onTrack: (track) => {
          if (gen !== this.connectionGen) return;
          this._handleTrack(track);
        },
        onStateChange: (s) => {
          if (gen !== this.connectionGen) return;
          if (s === "failed" || s === "disconnected") {
            this._fail("连接中断：" + s);
          }
        }
      });
    } catch (err) {
      this._fail(err && err.message ? err.message : String(err));
      this._notify();
      return;
    }

    try {
      await this.provider.start();
      // 连接过程中被手动断开，丢弃结果
      if (gen !== this.connectionGen) return;
      this.state = "live";
    } catch (err) {
      if (gen !== this.connectionGen) return;
      this._fail("拉流失败：" + (err && err.message ? err.message : String(err)));
    }
    this._notify();
  }

  _handleTrack(track) {
    if (track.kind === "video") {
      this.videoTrack = track;
      this._startFrameReader();
    } else if (track.kind === "audio") {
      this.audioTrack = track;
      if (this.onAudioTrack) this.onAudioTrack(this.id, track);
    }
  }

  /** 启动原始帧读取循环 */
  _startFrameReader() {
    if (this.reader) return;
    if (typeof MediaStreamTrackProcessor === "undefined") {
      this._fail("浏览器不支持 MediaStreamTrackProcessor（需 Chrome / Edge 94+）");
      return;
    }

    const processor = new MediaStreamTrackProcessor({ track: this.videoTrack });
    const reader = processor.readable.getReader();
    this.reader = reader;

    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          this.decodedFrames++;
          this.buffer.push(value);
        }
      } catch (err) {
        if (this.state !== "closed") {
          this._fail("帧读取异常：" + (err && err.message ? err.message : String(err)));
        }
      }
    })();
  }

  /**
   * 取与基准时间戳最接近的一帧
   * @param {number} refTsUs 基准帧时间戳（微秒）
   * @returns {VideoFrame|null}
   */
  getAlignFrame(refTsUs) {
    const offsets = this.config.timestampOffsetMs || {};
    const offsetUs = (offsets[this.id] || 0) * 1000;
    const toleranceUs = this.config.alignToleranceMs * 1000;
    return this.buffer.takeClosest(refTsUs + offsetUs, toleranceUs);
  }

  _fail(msg) {
    this.errorMessage = msg;
    this.state = "error";
    this._notify();
  }

  _notify() {
    if (this.onStateChange) this.onStateChange(this);
  }

  /** 释放本次连接占用的全部资源，可重复调用 */
  _cleanup() {
    if (this.reader) {
      try { this.reader.cancel(); } catch (e) { /* ignore */ }
      this.reader = null;
    }
    if (this.provider) {
      this.provider.close();
      this.provider = null;
    }
    this.buffer.clear();
    this.videoTrack = null;
    this.audioTrack = null;
  }

  disconnect() {
    // 代次自增，使仍在进行中的连接结果被丢弃
    this.connectionGen++;
    this.state = "closed";
    this.errorMessage = "";
    this._cleanup();
    this._notify();
  }
}
