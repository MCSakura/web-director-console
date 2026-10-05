/**
 * 帧同步调度模块
 * 原理：以基准机位（默认 cam01）最新帧的时间戳作为全局标尺，
 * 在其余机位的帧缓冲中匹配时间最接近的帧，实现帧级画面对齐；
 * 匹配过程中自动释放过期帧，防止延迟累积。
 */
class SyncEngine {
  /**
   * @param {object} config 全局配置
   * @param {{onAudioTrack?: Function}} [options]
   */
  constructor(config, options) {
    options = options || {};
    this.config = config;
    this.onChange = null;

    this.cameras = new Map();
    for (const def of config.cameras) {
      const cam = new CameraSource(def, config);
      cam.onAudioTrack = options.onAudioTrack || null;
      cam.onStateChange = () => { if (this.onChange) this.onChange(); };
      this.cameras.set(def.id, cam);
    }

    this.referenceId = config.referenceCameraId;
    if (!this.cameras.has(this.referenceId)) {
      this.referenceId = config.cameras.length ? config.cameras[0].id : null;
    }

    /** 当前实际使用的同步延迟（毫秒），供界面显示 */
    this.currentDelayMs = 0;
  }

  get reference() {
    return this.referenceId ? this.cameras.get(this.referenceId) : null;
  }

  get cameraList() {
    return Array.from(this.cameras.values());
  }

  /** 连接全部机位；已在连接中/已连接的会跳过，不会被重复断开 */
  async connectAll() {
    const pending = this.cameraList.filter((cam) => !cam.isActive);
    await Promise.all(pending.map((cam) => cam.connect()));
    if (this.onChange) this.onChange();
  }

  disconnectAll() {
    this.cameraList.forEach((cam) => cam.disconnect());
    if (this.onChange) this.onChange();
  }

  /**
   * 每个渲染帧调用一次，产出"同一时刻"的全部机位画面。
   * @returns {{refTs: number, refFrame: VideoFrame, frames: Map<string, VideoFrame>}|null}
   */
  tick() {
    const live = this.cameraList.filter((cam) => cam.buffer.length > 0);
    if (!live.length) return null;

    // 把各路「当前时刻」换算到统一标尺：common = 该路最新帧时间戳 - 该路校准偏移
    // （校准偏移的定义：某路取帧目标 = 标尺 + 该路偏移，所以反推即减去偏移）
    const offsets = this.config.timestampOffsetMs || {};
    const offOf = (cam) => (offsets[cam.id] || 0) * 1000;

    const commonNow = new Map();
    let slowestCommon = Infinity; // 送达最慢的那一路（统一标尺下的最小值）
    for (const cam of live) {
      const newest = cam.buffer.latest;
      if (!newest) continue;
      const v = newest.timestamp - offOf(cam);
      commonNow.set(cam.id, v);
      if (v < slowestCommon) slowestCommon = v;
    }
    if (commonNow.size === 0) return null;

    const ref = this.reference && commonNow.has(this.reference.id) ? this.reference : live[0];
    const refCommon = commonNow.get(ref.id);

    // 标尺：
    //   默认（syncMaxDelayMs = 0）跟随基准机位最新帧，延迟最低；
    //   开启自动补偿后自动退到"最慢那一路"，最多退 syncMaxDelayMs，避免某路卡顿把延迟拖爆。
    const maxDelayUs = Math.max(0, this.config.syncMaxDelayMs || 0) * 1000;
    let rulerCommon = maxDelayUs > 0
      ? Math.max(slowestCommon, refCommon - maxDelayUs)
      : refCommon;

    // 额外手动延迟：再往回退一点
    rulerCommon -= Math.max(0, this.config.syncExtraDelayMs || 0) * 1000;

    this.currentDelayMs = Math.max(0, (refCommon - rulerCommon) / 1000);

    // 基准机位取标尺附近的帧（不校验容差，保证一定有帧产出）
    const refFrame = ref.buffer.takeClosest(rulerCommon + offOf(ref), null);
    if (!refFrame) return null;

    const frames = new Map();
    frames.set(ref.id, refFrame);

    for (const [id, cam] of this.cameras) {
      if (id === ref.id) continue;
      // getAlignFrame 内部会把该路偏移加回标尺，并按容差校验
      const frame = cam.getAlignFrame(rulerCommon);
      if (frame) frames.set(id, frame);
    }

    return { refTs: refFrame.timestamp, refFrame: refFrame, frames: frames };
  }
}
