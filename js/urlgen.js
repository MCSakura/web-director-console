/**
 * 推/播流地址生成器（纯本地计算，不联网）
 *
 * 按腾讯云 / 阿里云的鉴权规则，在浏览器里直接算出带签名的推流地址与播放地址，
 * 省去在控制台逐个生成的麻烦（阿里云的鉴权串还是按流名单算的，6 路要各来一遍）。
 *
 * 鉴权 Key 只参与本地 MD5 计算，不会发送到任何服务器。
 */

/* ==================== MD5（UTF-8 → 32 位小写十六进制） ==================== */

/** 字符串按 UTF-8 编码成字节数组 */
function utf8Bytes(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        continue;
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

/** 字符串 MD5，返回 32 位小写十六进制 */
function md5Hex(str) {
  function safeAdd(x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  function core(x, len) {
    x[len >> 5] = (x[len >> 5] || 0) | (0x80 << (len % 32));
    x[(((len + 64) >>> 9) << 4) + 14] = len;

    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < x.length; i += 16) {
      var oa = a, ob = b, oc = c, od = d;

      a = ff(a, b, c, d, x[i], 7, -680876936);
      d = ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, x[i + 10], 17, -42063);
      b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = ff(b, c, d, a, x[i + 15], 22, 1236535329);

      a = gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = gg(b, c, d, a, x[i], 20, -373897302);
      a = gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = gg(b, c, d, a, x[i + 12], 20, -1926607734);

      a = hh(a, b, c, d, x[i + 5], 4, -378558);
      d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = hh(d, a, b, c, x[i], 11, -358537222);
      c = hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = hh(b, c, d, a, x[i + 2], 23, -995338651);

      a = ii(a, b, c, d, x[i], 6, -198630844);
      d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = ii(b, c, d, a, x[i + 9], 21, -343485551);

      a = safeAdd(a, oa);
      b = safeAdd(b, ob);
      c = safeAdd(c, oc);
      d = safeAdd(d, od);
    }
    return [a, b, c, d];
  }

  var bytes = utf8Bytes(str);
  var words = [];
  for (var i = 0; i < bytes.length; i++) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  }
  var out = core(words, bytes.length * 8);

  var hex = "";
  for (var j = 0; j < out.length * 4; j++) {
    hex += ("0" + ((out[j >> 2] >>> ((j % 4) * 8)) & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

/* ==================== 工具 ==================== */

/** 域名归一化：去掉协议前缀、路径和首尾空白 */
function normalizeDomain(d) {
  return String(d || "")
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "");
}

/** 去掉 AppName / 流名两端的斜杠和空白 */
function normalizePathPart(v) {
  return String(v || "").trim().replace(/^\/+|\/+$/g, "");
}

/** 把「cam01,cam02」这类文本或勾选的机位整理成去重后的流名数组 */
function resolveStreams(selected, fallback) {
  var list = (selected || []).map(String).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!list.length) {
    var f = String(fallback || "").trim();
    if (f) list = [f];
  }
  var seen = {};
  return list.filter(function (s) {
    if (seen[s]) return false;
    seen[s] = true;
    return true;
  });
}

/* ==================== 腾讯云 ==================== */

/**
 * 腾讯云直播鉴权：
 *   txTime   = 过期时间的十六进制
 *   txSecret = md5(鉴权KEY + 流名 + txTime)
 * 推流用推流域名的 KEY，播放用播流域名的 KEY。
 *
 * 返回里除逐条地址外，还带上可直接写进导播台的：
 *   template  —— 拉流通道地址模板（含 {cam} / {auth}）
 *   authKeys  —— 每路机位的鉴权参数（整串，如 txSecret=xxx&txTime=xxx）
 *   whipUrl   —— 成品回传（pgm 推流）地址
 */
function buildTencentUrls(p) {
  var pushDomain = normalizeDomain(p.pushDomain);
  var playDomain = normalizeDomain(p.playDomain);
  var app = normalizePathPart(p.app);
  var pushKey = String(p.pushKey || "").trim();
  var playKey = String(p.playKey || "").trim() || pushKey;
  var minutes = Number(p.minutes) > 0 ? Number(p.minutes) : 30;
  var streams = resolveStreams(p.streams, p.stream);
  var pgm = normalizePathPart(p.whipStream || "pgm");

  if (!pushDomain || !playDomain || !app) throw new Error("请填写推流域名、播流域名和 AppName");

  var txTime = Math.floor(Date.now() / 1000 + minutes * 60).toString(16).toUpperCase();

  /** 腾讯云 txSecret = md5(KEY + 流名 + txTime) */
  function query(key, stream) {
    return key ? "txSecret=" + md5Hex(key + stream + txTime) + "&txTime=" + txTime : "";
  }

  var out = { push: [], play: [], template: "", authKeys: {}, whipUrl: "" };

  streams.forEach(function (s) {
    var stream = normalizePathPart(s);
    var path = app + "/" + stream;
    var pq = query(pushKey, stream);
    var lq = query(playKey, stream);

    out.push.push({ label: "RTMP 推流", url: "rtmp://" + pushDomain + "/" + path + (pq ? "?" + pq : "") });
    out.push.push({ label: "快直播 WebRTC 推流", url: "webrtc://" + pushDomain + "/" + path + (pq ? "?" + pq : "") });
    out.play.push({ label: "快直播 WebRTC 播放", url: "webrtc://" + playDomain + "/" + path + (lq ? "?" + lq : "") });
    out.play.push({ label: "FLV 播放", url: "http://" + playDomain + "/" + path + ".flv" + (lq ? "?" + lq : "") });

    if (lq) out.authKeys[stream] = lq;
  });

  out.template = "webrtc://" + playDomain + "/" + app + "/{cam}" + (playKey ? "?{auth}" : "");

  var pgmQuery = query(pushKey, pgm);
  out.whipUrl = "webrtc://" + pushDomain + "/" + app + "/" + pgm + (pgmQuery ? "?" + pgmQuery : "");

  return out;
}

/* ==================== 阿里云 ==================== */

/**
 * 阿里云直播鉴权：
 *   auth_key  = timestamp-rand-uid-md5hash
 *   md5hash   = md5("{URI}-{timestamp}-{rand}-{uid}-{鉴权KEY}")
 * 其中 URI 是请求路径（不含 query），例如 /AppName/StreamName；
 * 用推流域名的 KEY 算推流地址，用播流域名的 KEY 算播放地址。
 *
 * 注意：timestamp 之后还会叠加「域名上配置的有效时长」，所以最终过期时间 = timestamp + 域名有效时长。
 */
function buildAliyunUrls(p) {
  var pushDomain = normalizeDomain(p.pushDomain);
  var playDomain = normalizeDomain(p.playDomain);
  var app = normalizePathPart(p.app);
  var pushKey = String(p.pushKey || "").trim();
  var playKey = String(p.playKey || "").trim() || pushKey;
  var minutes = Number(p.minutes) > 0 ? Number(p.minutes) : 0;
  var streams = resolveStreams(p.streams, p.stream);
  var pgm = normalizePathPart(p.whipStream || "pgm");

  if (!pushDomain || !playDomain || !app) throw new Error("请填写推流域名、播流域名和 AppName");

  var timestamp = Math.floor(Date.now() / 1000 + minutes * 60);
  var out = { push: [], play: [], template: "", authKeys: {}, whipUrl: "" };

  /** 阿里云 auth_key = timestamp-rand-uid-md5(URI-timestamp-rand-uid-KEY) */
  function query(uri, key) {
    if (!key) return "";
    return "auth_key=" + timestamp + "-0-0-" + md5Hex(uri + "-" + timestamp + "-0-0-" + key);
  }

  streams.forEach(function (s) {
    var stream = normalizePathPart(s);
    var uri = "/" + app + "/" + stream;
    var pq = query(uri, pushKey);
    var lq = query(uri, playKey);
    var lqFlv = query(uri + ".flv", playKey);

    out.push.push({ label: "RTMP 推流", url: "rtmp://" + pushDomain + uri + (pq ? "?" + pq : "") });
    out.push.push({ label: "RTS 推流", url: "artc://" + pushDomain + uri + (pq ? "?" + pq : "") });
    out.play.push({ label: "RTS 播放", url: "artc://" + playDomain + uri + (lq ? "?" + lq : "") });
    out.play.push({ label: "FLV 播放", url: "http://" + playDomain + uri + ".flv" + (lqFlv ? "?" + lqFlv : "") });

    if (lq) out.authKeys[stream] = lq;
  });

  out.template = "artc://" + playDomain + "/" + app + "/{cam}" + (playKey ? "?{auth}" : "");

  var pgmQuery = query("/" + app + "/" + pgm, pushKey);
  out.whipUrl = "artc://" + pushDomain + "/" + app + "/" + pgm + (pgmQuery ? "?" + pgmQuery : "");

  return out;
}
