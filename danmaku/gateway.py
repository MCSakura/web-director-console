#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站直播弹幕网关

为什么要网关：B 站的直播间信息、弹幕 token 都在 api.live.bilibili.com 上，
该域名不返回 CORS 头，浏览器直连一定失败；弹幕本身又走自定义二进制 WebSocket 协议。
所以用一个常驻进程代替浏览器完成「取 token → 连弹幕服务器 → 解析」，再通过
本进程自己的 WebSocket 转发给导播台。

对外协议（本网关监听 0.0.0.0:8099）
  WS  /danmaku      前端连接入口
  GET /health       健康检查（返回 JSON）

客户端 -> 网关
  {"action":"subscribe","room":"21452505"}      订阅（短号或真实房间号都行）
      可附加 "cookie" 字段传入 B站登录 Cookie（如 "SESSDATA=...; bili_jct=...; DedeUserID=..."），
      带上后弹幕昵称才是真实昵称；不带则 B站 会把昵称打码成 ***。
  {"action":"unsubscribe","room":"21452505"}    取消订阅
  {"action":"ping"}                             保活

网关 -> 客户端
  {"type":"hello","ver":1}
  {"type":"status","room":"<真实房间号>","state":"connecting|live|closed|error","msg":"...","title":"..."}
  {"type":"danmaku","room":"...","kind":"danmaku|gift|superchat","user":"...","text":"...","ts":1699999999,"extra":{}}
  {"type":"pong"}

依赖：websockets==12.0（其余全部为标准库）
"""

import asyncio
import http.cookiejar
import json
import logging
import os
import struct
import urllib.request
import zlib

import websockets

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
LOG = logging.getLogger("danmaku")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

HEADER_FMT = ">IHHII"
HEADER_LEN = 16

OP_HEARTBEAT = 2
OP_HEARTBEAT_REPLY = 3
OP_MESSAGE = 5
OP_AUTH = 7
OP_AUTH_REPLY = 8

# 游客 Cookie（buvid3 / buvid4 / b_nut 等）。B站对 getDanmuInfo 有风控，
# 不带这些会返回 -352。
COOKIES = {}

# 已登录 Cookie（可选）：由环境变量 DANMAKU_COOKIE 传入浏览器里的 B站 Cookie 串。
# 不带登录 Cookie 时弹幕长连接是匿名的，B站会把昵称打码成 ***；
# 带上 SESSDATA（建议连 bili_jct、DedeUserID 一起）后才会返回真实昵称。
COOKIE_ENV = os.environ.get("DANMAKU_COOKIE", "").strip()


def parse_cookie_string(raw):
    """把浏览器里复制的 "k=v; k2=v2" 串解析成字典"""
    out = {}
    for part in (raw or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def cookie_header(cookies=None):
    src = COOKIES if cookies is None else cookies
    if not src:
        return ""
    return "; ".join("%s=%s" % (k, v) for k, v in src.items())


# ---------------------------------------------------------------- 基础工具
def pack_packet(op, body=b"", protover=1):
    """按 B站协议打一个包头（16 字节，大端）"""
    return struct.pack(HEADER_FMT, len(body) + HEADER_LEN, HEADER_LEN, protover, op, 1) + body


def iter_packets(raw):
    """把一段字节流拆成若干 (protover, op, body)"""
    offset = 0
    total = len(raw)
    while offset + HEADER_LEN <= total:
        length, _, protover, op, _ = struct.unpack(HEADER_FMT, raw[offset:offset + HEADER_LEN])
        if length < HEADER_LEN or offset + length > total:
            break
        body = raw[offset + HEADER_LEN:offset + length]
        offset += length
        yield protover, op, body


def http_get_json(url, timeout=10):
    """阻塞式 GET，调用方用 asyncio.to_thread 包起来"""
    headers = {
        "User-Agent": UA,
        "Referer": "https://live.bilibili.com/",
        "Origin": "https://live.bilibili.com",
        "Accept": "application/json, text/plain, */*",
    }
    cookie = cookie_header()
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _bootstrap_cookies_blocking():
    """访问一次 B 站首页拿全套游客 Cookie，再补一次 buvid3/buvid4"""
    cookies = {}

    try:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        req = urllib.request.Request("https://www.bilibili.com/", headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
        })
        with opener.open(req, timeout=10) as resp:
            resp.read()
        for c in jar:
            cookies[c.name] = c.value
    except Exception as exc:
        LOG.warning("访问 B站首页取 Cookie 失败：%s", exc)

    try:
        data = http_get_json("https://api.bilibili.com/x/frontend/finger/spi")
        d = data.get("data") or {}
        if d.get("b_3"):
            cookies["buvid3"] = d["b_3"]
        if d.get("b_4"):
            cookies["buvid4"] = d["b_4"]
    except Exception as exc:
        LOG.warning("获取 buvid 失败：%s", exc)

    if not cookies.get("b_nut"):
        cookies["b_nut"] = str(int(__import__("time").time()))

    return cookies


async def bootstrap_cookies():
    """启动时取一次；失败也不阻塞，后续请求会自行报错"""
    global COOKIES
    try:
        COOKIES = await asyncio.to_thread(_bootstrap_cookies_blocking)
        LOG.info("已获取游客 Cookie：%s", ",".join(COOKIES.keys()) or "（空）")
    except Exception as exc:
        LOG.warning("初始化 Cookie 失败：%s", exc)

    login = parse_cookie_string(COOKIE_ENV)
    if login:
        COOKIES.update(login)
        LOG.info("已合并登录 Cookie：%s", ",".join(login.keys()))
    elif "SESSDATA" not in COOKIES:
        LOG.info("未配置登录 Cookie（DANMAKU_COOKIE），弹幕昵称会显示为 ***")


async def resolve_room(room_input):
    """短号 -> 真实房间号，并顺便拿直播间信息"""
    data = await asyncio.to_thread(
        http_get_json,
        "https://api.live.bilibili.com/room/v1/Room/get_info?room_id=%s" % room_input)
    if data.get("code") != 0:
        raise RuntimeError("查询直播间失败：%s" % data.get("message") or data.get("msg"))
    d = data["data"]
    return {
        "realRoomId": d["room_id"],
        "title": d.get("title") or "",
        "liveStatus": d.get("live_status"),
    }


async def fetch_danmu_server(real_room_id):
    """取弹幕长连接地址与 token

    B站对新接口 getDanmuInfo 有风控（-352），所以先试新接口，
    失败再退到旧接口 room/v1/Danmu/getConf。
    """
    errors = []

    # 1) 新接口
    try:
        data = await asyncio.to_thread(
            http_get_json,
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo"
            "?id=%s&type=0" % real_room_id)
        if data.get("code") == 0:
            d = data["data"] or {}
            hosts = d.get("host_list") or []
            if hosts:
                h = hosts[0]
                return d.get("token", ""), h.get("host"), int(h.get("wss_port") or 443)
        errors.append("getDanmuInfo=%s" % (data.get("code")))
    except Exception as exc:
        errors.append("getDanmuInfo 异常 %s" % exc)

    # 2) 旧接口兜底
    try:
        data = await asyncio.to_thread(
            http_get_json,
            "https://api.live.bilibili.com/room/v1/Danmu/getConf"
            "?room_id=%s&platform=pc&player=web" % real_room_id)
        if data.get("code") == 0:
            d = data["data"] or {}
            hosts = d.get("host_server_list") or d.get("server_list") or []
            if hosts:
                h = hosts[0]
                return d.get("token", ""), h.get("host"), int(h.get("wss_port") or 443)
        errors.append("getConf=%s" % (data.get("code")))
    except Exception as exc:
        errors.append("getConf 异常 %s" % exc)

    raise RuntimeError("获取弹幕服务器失败：" + "；".join(errors))


# ---------------------------------------------------------------- 单房间客户端
class BiliRoom:
    """维持一个直播间的弹幕长连接，事件通过 emit 回调抛给网关"""

    def __init__(self, room_input, emit, cookie=""):
        self.room_input = str(room_input)
        self.emit = emit            # async def emit(event: dict)
        self.real_room_id = None
        self.title = ""
        self.task = None
        self.stopped = False
        self.refs = 0               # 订阅该房间的客户端数
        # 客户端订阅时传入的登录 Cookie 原文（留空则匿名连接，昵称会被打码成 ***）
        self.cookie_raw = (cookie or "").strip()
        self.login_cookies = parse_cookie_string(self.cookie_raw)
        self.backoff = 3            # 重连退避（秒）
        self.fail_count = 0         # 连续失败次数

    def start(self):
        if self.task is None:
            self.task = asyncio.create_task(self._run())

    async def stop(self):
        self.stopped = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
            self.task = None

    # --- 内部 ---
    async def _status(self, state, msg=""):
        await self.emit({
            "type": "status",
            "room": self.real_room_id or self.room_input,
            "state": state,
            "msg": msg,
            "title": self.title,
        })

    async def _run(self):
        while not self.stopped:
            try:
                await self._status("connecting")
                info = await resolve_room(self.room_input)
                self.real_room_id = info["realRoomId"]
                self.title = info["title"]

                token, host, port = await fetch_danmu_server(self.real_room_id)
                url = "wss://%s:%d/sub" % (host, port)
                LOG.info("[%s] 连接弹幕服务器 %s", self.real_room_id, url)

                # 本房间实际使用的 Cookie：游客 Cookie 打底，登录 Cookie（客户端传入）覆盖
                room_cookies = dict(COOKIES)
                room_cookies.update(self.login_cookies)

                ws_headers = {
                    "User-Agent": UA,
                    "Origin": "https://live.bilibili.com",
                }
                # 登录 Cookie 必须带在握手请求上，B站才会返回真实昵称（否则为 ***）
                cookie = cookie_header(room_cookies)
                if cookie:
                    ws_headers["Cookie"] = cookie

                async with websockets.connect(
                        url,
                        extra_headers=ws_headers,
                        max_size=None,
                        ping_interval=None,
                        close_timeout=5) as ws:

                    # 登录状态下用真实 uid（取自 DedeUserID）
                    uid = 0
                    dede = room_cookies.get("DedeUserID")
                    if room_cookies.get("SESSDATA") and dede and dede.isdigit():
                        uid = int(dede)
                    auth = {
                        "uid": uid,
                        "roomid": self.real_room_id,
                        "protover": 2,
                        "platform": "web",
                        "clientver": "1.11.0",
                        "type": 2,
                        "key": token,
                    }
                    buvid3 = room_cookies.get("buvid3")
                    if buvid3:
                        auth["buvid"] = buvid3
                    await ws.send(pack_packet(OP_AUTH, json.dumps(auth).encode("utf-8")))

                    hb = asyncio.create_task(self._heartbeat(ws))
                    try:
                        # 真正的「已连接」状态在收到 B站认证回执后才发出（见 _on_message）
                        async for raw in ws:
                            await self._on_message(raw)
                    finally:
                        hb.cancel()

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.warning("[%s] 连接异常：%s", self.real_room_id or self.room_input, exc)
                await self._status("error", str(exc))

            if self.stopped:
                break

            # 连续失败：若带了登录 Cookie，多半是它失效/填错导致被 B站拒连，
            # 退化为匿名连接（昵称会变成 ***，但至少弹幕不断）
            self.fail_count += 1
            if self.login_cookies and self.fail_count >= 2:
                LOG.warning("[%s] 带登录 Cookie 连续失败，改为匿名连接（昵称显示为 ***）",
                            self.real_room_id or self.room_input)
                self.login_cookies = {}
                self.fail_count = 0

            await self._status("closed", "%d 秒后重连" % self.backoff)
            await asyncio.sleep(self.backoff)
            self.backoff = min(self.backoff * 2, 60)

    async def _heartbeat(self, ws):
        try:
            while True:
                await asyncio.sleep(30)
                await ws.send(pack_packet(OP_HEARTBEAT, b"[object Object]"))
        except Exception:
            pass

    async def _on_message(self, raw):
        if isinstance(raw, str):
            return
        for protover, op, body in iter_packets(raw):
            if op == OP_HEARTBEAT_REPLY:
                continue
            if op == OP_AUTH_REPLY:
                LOG.info("[%s] 认证成功", self.real_room_id)
                self.fail_count = 0
                self.backoff = 3
                await self._status("live")
                continue
            if op != OP_MESSAGE:
                continue

            if protover == 2:
                try:
                    await self._on_message(zlib.decompress(body))
                except Exception as exc:
                    LOG.debug("解压失败：%s", exc)
                continue
            if protover == 1:
                continue  # 人气值
            try:
                payload = json.loads(body.decode("utf-8", "replace"))
            except Exception:
                continue
            await self._dispatch(payload)

    async def _dispatch(self, payload):
        cmd = payload.get("cmd") or ""
        data = payload.get("data") or {}

        if cmd == "DANMU_MSG":
            info = payload.get("info") or []
            text = info[1] if len(info) > 1 else ""
            user = ""
            uid = 0
            if len(info) > 2 and isinstance(info[2], list) and len(info[2]) > 1:
                uid = info[2][0]
                user = info[2][1]
            ts = 0
            if len(info) > 9 and isinstance(info[9], dict):
                ts = info[9].get("ts") or 0
            await self._send("danmaku", user, text, ts, {"uid": uid})

        elif cmd == "SUPER_CHAT_MESSAGE":
            user = ((data.get("user_info") or {}).get("uname")) or ""
            await self._send("superchat", user, data.get("message") or "",
                             int(data.get("ts") or 0), {"price": data.get("price")})

        elif cmd == "SEND_GIFT":
            user = data.get("uname") or ""
            gift = data.get("giftName") or ""
            num = data.get("num") or 1
            await self._send("gift", user, "%s x%s" % (gift, num),
                             int(data.get("timestamp") or 0),
                             {"gift": gift, "num": num})

    async def _send(self, kind, user, text, ts, extra):
        if not text:
            return
        await self.emit({
            "type": "danmaku",
            "room": self.real_room_id or self.room_input,
            "kind": kind,
            "user": user,
            "text": text,
            "ts": ts,
            "extra": extra or {},
        })


# ---------------------------------------------------------------- 网关
class Gateway:
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.rooms = {}          # 真实/输入房间号 -> BiliRoom
        self.subs = {}           # 客户端 -> set(房间号)
        self.clients = set()

    # 网关 -> 客户端
    async def broadcast(self, room_id, event):
        dead = []
        for ws in list(self.clients):
            if room_id not in self.subs.get(ws, set()):
                continue
            try:
                await ws.send(json.dumps(event, ensure_ascii=False))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)
            self.subs.pop(ws, None)

    async def _emit_for(self, room_key):
        async def emit(event):
            await self.broadcast(room_key, event)
        return emit

    async def ensure_room(self, room_input, cookie=""):
        key = str(room_input)
        cookie = (cookie or "").strip()
        room = self.rooms.get(key)

        # 登录 Cookie 变了（例如刚在页面上填上或清空），断开重连让它立即生效
        if room is not None and room.cookie_raw != cookie:
            prev_refs = room.refs
            await room.stop()
            self.rooms.pop(key, None)
            LOG.info("房间 Cookie 已变更，重新订阅：%s", key)
            room = BiliRoom(key, await self._emit_for(key), cookie)
            room.refs = prev_refs
            self.rooms[key] = room
            room.start()
            return room

        if room is None:
            room = BiliRoom(key, await self._emit_for(key), cookie)
            self.rooms[key] = room
            room.start()
            LOG.info("新建房间订阅：%s%s", key, "（含登录 Cookie）" if cookie else "")
        return room

    async def drop_room_if_idle(self, key):
        room = self.rooms.get(key)
        if room and room.refs <= 0:
            await room.stop()
            self.rooms.pop(key, None)
            LOG.info("房间订阅已释放：%s", key)

    # 客户端连接
    async def handler(self, websocket, *args):
        path = getattr(websocket, "path", "/") or "/"
        if not path.startswith("/danmaku"):
            await websocket.close(code=1008, reason="unknown path")
            return

        self.clients.add(websocket)
        self.subs[websocket] = set()
        LOG.info("客户端接入，当前 %d 个", len(self.clients))

        try:
            await websocket.send(json.dumps({"type": "hello", "ver": 1}))
            async for message in websocket:
                try:
                    msg = json.loads(message)
                except Exception:
                    continue
                action = msg.get("action")

                if action == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))

                elif action == "subscribe":
                    key = str(msg.get("room") or "").strip()
                    if not key:
                        continue
                    room = await self.ensure_room(key, msg.get("cookie") or "")
                    room.refs += 1
                    self.subs[websocket].add(key)
                    await websocket.send(json.dumps({
                        "type": "status", "room": key, "state": "connecting",
                        "msg": "已订阅", "title": room.title,
                    }, ensure_ascii=False))

                elif action == "unsubscribe":
                    key = str(msg.get("room") or "").strip()
                    room = self.rooms.get(key)
                    if room:
                        room.refs -= 1
                    self.subs[websocket].discard(key)
                    await self.drop_room_if_idle(key)

        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            keys = self.subs.pop(websocket, set())
            for key in keys:
                room = self.rooms.get(key)
                if room:
                    room.refs -= 1
                await self.drop_room_if_idle(key)
            LOG.info("客户端断开，当前 %d 个", len(self.clients))

    async def process_request(self, path, request_headers):
        """非 /danmaku 的普通 HTTP 请求：给一个健康检查"""
        if path and path.startswith("/health"):
            body = json.dumps({
                "ok": True,
                "rooms": len(self.rooms),
                "clients": len(self.clients),
            }).encode("utf-8")
            return (200, [("Content-Type", "application/json"),
                          ("Content-Length", str(len(body)))], body)
        return None

    async def serve(self):
        await bootstrap_cookies()
        async with websockets.serve(
                self.handler,
                self.host,
                self.port,
                process_request=self.process_request,
                max_size=None,
                ping_interval=20,
                ping_timeout=20):
            LOG.info("弹幕网关已启动：ws://%s:%d/danmaku", self.host, self.port)
            await asyncio.Future()


def main():
    host = os.environ.get("DANMAKU_HOST", "0.0.0.0")
    port = int(os.environ.get("DANMAKU_PORT", "8099"))
    try:
        asyncio.run(Gateway(host, port).serve())
    except KeyboardInterrupt:
        LOG.info("已停止")


if __name__ == "__main__":
    main()
