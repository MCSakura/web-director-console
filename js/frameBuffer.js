/**
 * 帧缓存与 PTS 解析
 * 单路机位维护一个按时间顺序排列的 VideoFrame FIFO 队列。
 * VideoFrame.timestamp 单位为微秒，由浏览器依据流的 PTS 给出。
 *
 * 注意：VideoFrame 占用 GPU/解码资源，必须显式 close()，
 * 所有被丢弃的帧都会在此处统一释放。
 */
class FrameBuffer {
  constructor(maxFrames) {
    this.maxFrames = maxFrames || 15;
    this.frames = [];
  }

  get length() {
    return this.frames.length;
  }

  push(frame) {
    this.frames.push(frame);
    // 超出上限，丢弃最旧帧，避免延迟累积
    while (this.frames.length > this.maxFrames) {
      this._closeFrame(this.frames.shift());
    }
  }

  get latest() {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  /**
   * 找到时间戳最接近 targetTsUs 的帧，并释放该帧之前的所有旧帧。
   * @param {number} targetTsUs 目标时间戳（微秒）
   * @param {number|null} toleranceUs 容差（微秒）；超出容差返回 null。传 null 表示不校验
   * @returns {VideoFrame|null}
   */
  takeClosest(targetTsUs, toleranceUs) {
    if (!this.frames.length) return null;

    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < this.frames.length; i++) {
      const diff = Math.abs(this.frames[i].timestamp - targetTsUs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    // 释放被跳过的过期帧
    for (let i = 0; i < bestIdx; i++) {
      this._closeFrame(this.frames[i]);
    }
    this.frames.splice(0, bestIdx);

    if (toleranceUs != null && bestDiff > toleranceUs) return null;
    return this.frames[0] || null;
  }

  /** 释放全部帧 */
  clear() {
    this.frames.forEach((f) => this._closeFrame(f));
    this.frames = [];
  }

  _closeFrame(frame) {
    if (!frame) return;
    try { frame.close(); } catch (e) { /* 已释放则忽略 */ }
  }
}
