/**
 * B站弹幕面板（仅监看）
 *
 * 弹幕不在前端直连 B站：api.live.bilibili.com 不返回 CORS 头，
 * 且弹幕走自定义二进制协议。实际连接由独立网关完成
 * （见 danmaku/gateway.py），本模块只负责与网关的 WebSocket 通信与列表渲染。
 */
class DanmakuPanel {
  /**
   * @param {object} config  { gatewayUrl, port, room, maxItems }
   * @param {{onLog?: Function}} options
   */
  constructor(config, options) {
    this.config = config || {};
    this.onLog = (options && options.onLog) || function () {};

    this.listEl = document.getElementById("dmList");
    this.statusEl = document.getElementById("dmStatus");
    this.lightEl = document.getElementById("dmLight");

    this.ws = null;
    this.room = "";
    /** B站登录 Cookie（可选）：带上后昵称才是真实昵称，否则 B站会打码成 *** */
    this.cookie = "";
    this.closedByUser = true;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.retryDelay = 2000;
    this.maxItems = this.config.maxItems || 200;
  }

  /** 留空则按页面主机推导：ws(s)://<当前主机>:<port>/danmaku */
  gatewayUrl() {
    const explicit = (this.config.gatewayUrl || "").trim();
    if (explicit) return explicit;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const port = this.config.port || 8099;
    return proto + "//" + window.location.hostname + ":" + port + "/danmaku";
  }

  setStatus(state, text) {
    if (this.statusEl) this.statusEl.textContent = text;
    if (this.lightEl) {
      this.lightEl.className = "status-light" +
        (state === "live" ? " on" : state === "connecting" ? " warn" : state === "error" ? " err" : "");
    }
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ---------- 连接管理 ----------
  connect(room, cookie) {
    const roomId = String(room || "").trim();
    if (!roomId) {
      this.onLog("请先填写 B站直播间号", "error");
      return false;
    }

    // 不传 cookie 时沿用上一次的（重连场景）
    if (cookie !== undefined) this.cookie = String(cookie || "").trim();

    this.disconnect(true);
    this.room = roomId;
    this.closedByUser = false;
    this.retryDelay = 2000;

    const url = this.gatewayUrl();
    this.setStatus("connecting", "连接网关中…");

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setStatus("error", "网关地址无效：" + url);
      this.onLog("弹幕网关地址无效：" + url, "error");
      return false;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.onLog("弹幕网关已连接：" + url, "ok");
      this.setStatus("connecting", "订阅直播间 " + roomId + " …");
      const sub = { action: "subscribe", room: roomId };
      if (this.cookie) sub.cookie = this.cookie;
      this.send(sub);
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onerror = () => {
      this.setStatus("error", "网关连接出错");
    };

    ws.onclose = () => {
      this.stopPing();
      if (this.closedByUser) {
        this.setStatus("", "未连接");
        return;
      }
      const wait = Math.round(this.retryDelay / 1000);
      this.setStatus("connecting", "网关断开，" + wait + " 秒后重连");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closedByUser) this.connect(this.room);
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    };

    return true;
  }

  /** 主动断开（silent=true 用于重连前的清理，不打日志） */
  disconnect(silent) {
    this.closedByUser = true;
    this.retryDelay = 2000;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    if (!silent) {
      this.setStatus("", "未连接");
      this.onLog("弹幕已断开", "warn");
    }
  }

  send(obj) {
    if (this.connected) {
      try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ action: "ping" }), 25000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---------- 消息处理 ----------
  handleMessage(msg) {
    if (msg.type === "status") {
      const map = {
        connecting: ["connecting", "订阅中…"],
        live: ["live", "已连接直播间 " + (msg.room || "")],
        closed: ["", "已断开：" + (msg.msg || "")],
        error: ["error", "出错：" + (msg.msg || "")]
      };
      const [state, text] = map[msg.state] || ["", msg.state];
      this.setStatus(state, text);
      if (msg.title) {
        this.statusEl.textContent = text + "（" + msg.title + "）";
      }
      return;
    }

    if (msg.type !== "danmaku") return;

    const kind = msg.kind || "danmaku";
    const time = msg.ts ? new Date(msg.ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : "";
    let text = msg.text || "";
    if (kind === "gift") text = "🎁 " + text;
    if (kind === "superchat") text = "💰 " + text;

    this.append(this.timeOrNow(time), msg.user || "", text, kind);
  }

  timeOrNow(t) {
    return t || new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  append(time, user, text, kind) {
    if (!this.listEl) return;

    // 用户往上翻看历史时不打断
    const atBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 30;

    const item = document.createElement("div");
    item.className = "dm-item dm-" + kind;

    const t = document.createElement("span");
    t.className = "dm-time";
    t.textContent = time + " ";

    const u = document.createElement("span");
    u.className = "dm-user";
    u.textContent = user ? user + "：" : "";

    const c = document.createElement("span");
    c.className = "dm-text";
    c.textContent = text;

    item.appendChild(t);
    item.appendChild(u);
    item.appendChild(c);
    this.listEl.appendChild(item);

    while (this.listEl.childElementCount > this.maxItems) {
      this.listEl.removeChild(this.listEl.firstChild);
    }
    if (atBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  clear() {
    if (this.listEl) this.listEl.innerHTML = "";
  }
}
