/**
 * 音频混音模块
 * 基于 WebAudio：每路机位音频 → 独立增益节点 → 主增益 →
 *   ① MediaStreamDestination（供成品输出流混入音频轨）
 *   ② 监听输出（可选，默认关闭，避免现场回声）
 */
class AudioMixer {
  constructor(config) {
    this.config = config;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    this.master = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();

    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = 0;

    this.master.connect(this.dest);
    this.master.connect(this.monitorGain);
    this.monitorGain.connect(this.ctx.destination);

    /**
     * 每路机位的目标音量 / 静音状态。
     * 与「是否已连接」解耦：先调好再连接、或断开重连，都会自动套用，不会被重置回 100%。
     */
    this.volumes = new Map();
    this.mutes = new Map();

    /** @type {Map<string, {source: MediaStreamAudioSourceNode, gain: GainNode, muted: boolean, volume: number}>} */
    this.channels = new Map();
  }

  /** 浏览器要求音频上下文需在用户手势后恢复 */
  async resume() {
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }
  }

  /** 接入一路机位音频轨 */
  addTrack(camId, track) {
    if (this.channels.has(camId)) return;
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = this.ctx.createGain();
    source.connect(gain);
    gain.connect(this.master);

    // 音量条接在增益之后：调音量 / 静音时能立刻从音量条上看到变化
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser);

    // 套用连接前就设好的音量 / 静音，避免连上后被重置成 100%
    const volume = this.volumes.has(camId) ? this.volumes.get(camId) : 1;
    const muted = !!this.mutes.get(camId);
    gain.gain.value = muted ? 0 : volume;

    this.channels.set(camId, {
      source, gain, analyser,
      muted, volume,
      _timeData: new Uint8Array(analyser.fftSize)
    });
  }

  /** 移除并释放一路机位音频（断开机位时调用） */
  removeChannel(camId) {
    const ch = this.channels.get(camId);
    if (!ch) return;
    try { ch.source.disconnect(); } catch (e) { /* ignore */ }
    try { ch.gain.disconnect(); } catch (e) { /* ignore */ }
    try { ch.analyser.disconnect(); } catch (e) { /* ignore */ }
    this.channels.delete(camId);
  }

  /**
   * 读取某路机位的当前音量（0~1）。
   * 基于 AnalyserNode 的时域 PCM 计算 RMS，再做感知型压缩，避免小声几乎看不见。
   */
  getLevel(camId) {
    const ch = this.channels.get(camId);
    if (!ch || !ch.analyser) return 0;
    ch.analyser.getByteTimeDomainData(ch._timeData);
    let sum = 0;
    const data = ch._timeData;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    // 压缩动态范围并放大，使正常说话能占到 0.3~0.7
    return Math.min(1, Math.pow(rms, 0.6) * 2.2);
  }

  setVolume(camId, volume) {
    const v = Math.max(0, Math.min(1, Number(volume) || 0));
    this.volumes.set(camId, v);
    const ch = this.channels.get(camId);
    if (!ch) return; // 还没连接：记下来，addTrack 时套用
    ch.volume = v;
    ch.gain.gain.value = ch.muted ? 0 : v;
  }

  setMuted(camId, muted) {
    const m = !!muted;
    this.mutes.set(camId, m);
    const ch = this.channels.get(camId);
    if (!ch) return; // 还没连接：记下来，addTrack 时套用
    ch.muted = m;
    ch.gain.gain.value = m ? 0 : ch.volume;
  }

  setMaster(volume) {
    this.master.gain.value = volume;
  }

  setMonitor(on) {
    this.monitorGain.gain.value = on ? 1 : 0;
  }

  /** 混音后的音频轨，供成品输出流使用 */
  get outputTrack() {
    return this.dest.stream.getAudioTracks()[0] || null;
  }
}
