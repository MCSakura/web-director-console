/**
 * Canvas 合成渲染模块
 * 负责把同步后的多机位画面合成为导播成品：机位硬切 / 叠化转场、画中画、台标。
 */

/** 读取 VideoFrame / Canvas / Image 的显示尺寸 */
function sourceSize(src) {
  return {
    w: src.displayWidth || src.videoWidth || src.naturalWidth || src.width || 0,
    h: src.displayHeight || src.videoHeight || src.naturalHeight || src.height || 0
  };
}

/** 等比缩放绘制（letterbox，不裁切、不变形） */
function drawFit(ctx, src, dx, dy, dw, dh) {
  const size = sourceSize(src);
  if (!size.w || !size.h) return;
  const scale = Math.min(dw / size.w, dh / size.h);
  const w = size.w * scale;
  const h = size.h * scale;
  ctx.drawImage(src, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
}

class Compositor {
  /**
   * @param {HTMLCanvasElement} canvas 成品输出画布
   * @param {object} config 全局配置
   */
  constructor(canvas, config) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.config = config;

    this.programId = config.referenceCameraId;
    this.pipId = null;
    this.logoImage = null;
    // 台标宽度：占成品画面的比例，可现场调整
    this.logoWidthScale = config.logoWidthScale != null ? config.logoWidthScale : 0.12;
    this.transitionMs = 300;

    // 转场用的上一帧成品快照
    this._snapshot = document.createElement("canvas");
    this._snapshot.width = canvas.width;
    this._snapshot.height = canvas.height;
    this._snapCtx = this._snapshot.getContext("2d");
    this._snapshotReady = false;
    this._transitionStart = null;
  }

  /** 切换节目机位；转场时长 > 0 时执行叠化，否则硬切 */
  setProgram(id) {
    if (id === this.programId) return;
    if (this.transitionMs > 0) {
      this._snapCtx.drawImage(this.canvas, 0, 0);
      this._snapshotReady = true;
      this._transitionStart = performance.now();
    } else {
      this._snapshotReady = false;
      this._transitionStart = null;
    }
    this.programId = id;
  }

  setPip(id) {
    this.pipId = id || null;
  }

  setLogo(image) {
    this.logoImage = image || null;
  }

  /** 台标宽度（占成品画面宽度的比例，如 0.12 = 12%） */
  setLogoWidthScale(scale) {
    this.logoWidthScale = Number(scale) || 0;
  }

  setTransitionMs(ms) {
    this.transitionMs = Math.max(0, ms | 0);
  }

  /**
   * 渲染一帧成品
   * @param {{refFrame: VideoFrame, frames: Map<string, VideoFrame>}|null} syncResult
   * @param {number} now 当前时间（performance.now()）
   */
  render(syncResult, now) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    const frames = syncResult ? syncResult.frames : null;
    let programFrame = null;
    if (frames) {
      programFrame = frames.get(this.programId) || syncResult.refFrame || null;
    }

    if (programFrame) {
      try { drawFit(ctx, programFrame, 0, 0, W, H); } catch (e) { /* 帧可能已释放 */ }
    }

    // 画中画
    if (this.pipId && frames) {
      const pipFrame = frames.get(this.pipId);
      if (pipFrame) {
        const size = sourceSize(pipFrame);
        const aspect = (size.w && size.h) ? size.h / size.w : 9 / 16;
        const pw = Math.round(W * this.config.pipScale);
        const ph = Math.round(pw * aspect);
        const margin = Math.round(W * 0.02);
        const x = W - pw - margin;
        const y = H - ph - margin;

        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,.7)";
        ctx.shadowBlur = 14;
        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, pw, ph);
        ctx.restore();

        try { drawFit(ctx, pipFrame, x, y, pw, ph); } catch (e) { /* ignore */ }

        ctx.strokeStyle = "rgba(255,255,255,.55)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, pw, ph);
      }
    }

    // 转场叠化：把切换前的成品快照叠在新画面上，逐渐淡出
    if (this._snapshotReady && this._transitionStart != null) {
      const progress = Math.min(1, (now - this._transitionStart) / Math.max(1, this.transitionMs));
      ctx.globalAlpha = 1 - progress;
      ctx.drawImage(this._snapshot, 0, 0);
      ctx.globalAlpha = 1;
      if (progress >= 1) {
        this._snapshotReady = false;
        this._transitionStart = null;
      }
    }

    // 台标
    if (this.logoImage) {
      const lw = Math.max(1, Math.round(W * this.logoWidthScale));
      const lh = Math.round(lw * (this.logoImage.height / this.logoImage.width));
      const margin = Math.round(W * 0.02);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.logoImage, W - lw - margin, margin, lw, lh);
      ctx.globalAlpha = 1;
    }
  }
}
