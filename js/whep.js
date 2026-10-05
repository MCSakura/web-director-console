/**
 * WHEP 拉流客户端
 * 负责与 ZLMediaKit 建立一路 WebRTC 接收连接（recvonly），
 * 并把远端视频/音频轨道回调给上层。
 */

/**
 * 等待 ICE 收集完成（ZLMediaKit 采用非 trickle 方式，需要完整 SDP）。
 * @param {RTCPeerConnection} pc
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitIceGathering(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();

    let timer = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };

    pc.addEventListener("icegatheringstatechange", onChange);
    timer = setTimeout(finish, timeoutMs || 2000);
  });
}

/** 把 HTTP 错误响应转成可读信息（服务端一般会把原因写进响应体，例如 errcode/errmsg） */
async function describeHttpError(resp) {
  let detail = "";
  try {
    detail = (await resp.text()).trim();
  } catch (e) { /* ignore */ }
  if (detail.length > 140) detail = detail.slice(0, 140) + "…";

  let msg = "HTTP " + resp.status;
  if (detail) msg += "：" + detail;
  return msg;
}

/**
 * SDP 必须以换行结尾。若结尾缺少换行，Chrome 解析时会把最后一行判为
 * "Invalid SDP line"（报错会指向最后一行，容易误以为是该行内容有问题）。
 */
function ensureSdpTrailingNewline(sdp) {
  if (!sdp) return sdp;
  return /\r?\n$/.test(sdp) ? sdp : sdp + "\r\n";
}

/**
 * 兼容两种 SDP 返回格式：
 *  1) 标准 WHEP/WHIP：响应体直接是 answer SDP（以 v= 开头）
 *  2) 私有信令：响应体是 JSON { code, sdp } / { errcode, errmsg }
 */
function parseSdpAnswer(body) {
  const text = (body || "").trim();
  if (!text) throw new Error("服务端返回空 SDP");
  if (text.indexOf("v=") === 0) return ensureSdpTrailingNewline(text);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("无法解析服务端返回内容：" + text.slice(0, 140));
  }
  if (json && json.code !== undefined && json.code !== 0) {
    throw new Error("服务端错误码 " + json.code + (json.msg ? "：" + json.msg : ""));
  }
  // 腾讯云信令的错误格式：{"errcode": -12, "errmsg": "streamurl authentication failed"}
  if (json && json.errcode !== undefined && json.errcode !== 0) {
    throw new Error("服务端错误码 " + json.errcode + (json.errmsg ? "：" + json.errmsg : ""));
  }
  if (json && json.sdp) return ensureSdpTrailingNewline(json.sdp);
  throw new Error("服务端返回内容中没有 SDP：" + (text.slice(0, 140) || "（空）"));
}

class WhepClient {
  /**
   * @param {object} opts
   * @param {string[]} opts.urls 候选 WHEP 地址，按顺序尝试
   * @param {(track: MediaStreamTrack) => void} opts.onTrack 收到远端轨道
   * @param {(state: string) => void} [opts.onStateChange] 连接状态变化
   */
  constructor(opts) {
    this.urls = opts.urls || [];
    this.onTrack = opts.onTrack || function () {};
    this.onStateChange = opts.onStateChange || function () {};

    this.pc = null;
    this.activeUrl = null;
  }

  async connect() {
    // 纯内网传输，无需 STUN/TURN
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (event) => {
      if (event.track) this.onTrack(event.track);
    };
    pc.onconnectionstatechange = () => {
      this.onStateChange(pc.connectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc, 2000);

    const sdp = pc.localDescription.sdp;
    // 全部候选地址都失败时，上报「主通道」的报错（备选通道的报错往往只是路由不存在，会掩盖真实原因）
    let primaryError = null;
    for (const url of this.urls) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/sdp",
            "Accept": "application/sdp"
          },
          body: sdp
        });
        if (!resp.ok) throw new Error(await describeHttpError(resp));

        const answer = parseSdpAnswer(await resp.text());
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        this.activeUrl = url;
        return url;
      } catch (err) {
        if (!primaryError) primaryError = err;
      }
    }

    // 全部候选地址都失败，释放连接
    try { pc.close(); } catch (e) { /* ignore */ }
    this.pc = null;
    throw primaryError || new Error("WHEP 拉流失败");
  }

  close() {
    if (this.pc) {
      try { this.pc.close(); } catch (e) { /* ignore */ }
      this.pc = null;
    }
  }
}
