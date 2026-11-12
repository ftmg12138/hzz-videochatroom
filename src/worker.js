// videochatroom.xyzhzz.com 入口 Worker
// 账号、会话、房间登记和访问日志全部复用 chatroom Worker 的 Directory（script_name 绑定），Cookie 共享（Domain=xyzhzz.com）。
import { VideoRoom } from "./videoroom.js";
export { VideoRoom };

const COOKIE = "hzz_sid";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (status, error) => json({ error }, status);
const ctxOf = (req) => ({
  ip: req.headers.get("CF-Connecting-IP") || "",
  country: req.cf?.country || "",
  ua: req.headers.get("User-Agent") || "",
  path: "videochatroom" + new URL(req.url).pathname,
});
function getToken(req) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}
function cookieHeader(env, token, maxAge = 30 * 86400) {
  const dom = env.COOKIE_DOMAIN ? `; Domain=${env.COOKIE_DOMAIN}` : "";
  return `${COOKIE}=${token || ""}; Path=/${dom}; HttpOnly; Secure; SameSite=Lax; Max-Age=${token ? maxAge : 0}`;
}
function originOk(req, env) {
  const o = req.headers.get("Origin");
  if (!o) return true;
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).includes(o);
}
async function body(req) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}
const dir = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
const vroom = (env, n) => env.VROOMS.get(env.VROOMS.idFromName(String(n).toLowerCase()));
const out = (r) => (r.ok ? json(r.data) : err(r.status, r.error));

// 声网 SDK 需要连接其动态分配的网关/边缘节点（https/wss，域名和 IP 不固定），并会给自己创建的隐藏元素写内联样式
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// stun.miwifi.com（小米）在国内可达；Google STUN 在国内基本不可用，只作海外兜底
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.miwifi.com:3478", "stun:stun.l.google.com:19302"] }];
const TURN_TTL = 6 * 3600;
const splitUrls = (v) => String(v || "").split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^turns?:/.test(x));
const noPort53 = (urls) => urls.filter((u) => !/:53(\?|$)/.test(u)); // 53 端口常被浏览器/网络拦截
let meteredCache = null; // { at, list } — 同一 isolate 内缓存 10 分钟，避免每次进房都请求服务商

// TURN 来源（按优先级，可同时配置多个，结果合并）：
//  1) Cloudflare Realtime TURN：TURN_KEY_ID + TURN_KEY_API_TOKEN → 服务端签发短期凭据
//  2) Metered / Open Relay：METERED_API_KEY + METERED_APP（xxx.metered.live 的 xxx）[+ METERED_REGION] → 服务端拉取 iceServers
//  3) 自建 coturn（use-auth-secret）：TURN_URLS + TURN_SECRET → 本地用 HMAC-SHA1 签发限时凭据（密钥不下发浏览器）
//  4) 固定账号（ExpressTURN 免费版等）：TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL → 原样下发（TURN 协议本身需要浏览器持有该账号）
async function iceServersFor(env, user) {
  const iceServers = [...STUN], via = [];
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: TURN_TTL }),
      });
      if (r.ok) {
        const d = await r.json();
        const list = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
        for (const s of list) {
          const urls = noPort53((Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === "string" && u.startsWith("turn")));
          if (urls.length) { iceServers.push({ urls, username: s.username, credential: s.credential }); via.push("cloudflare"); }
        }
      }
    } catch {}
  }
  if (env.METERED_API_KEY && env.METERED_APP) {
    try {
      let list = meteredCache && Date.now() - meteredCache.at < 600000 ? meteredCache.list : null;
      if (!list) {
        const app = String(env.METERED_APP).replace(/^https?:\/\//, "").replace(/\.metered\.live.*$/, "");
        if (/^[a-z0-9-]+$/i.test(app)) {
          const q = new URLSearchParams({ apiKey: env.METERED_API_KEY }); if (env.METERED_REGION) q.set("region", env.METERED_REGION);
          const r = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?${q}`, { headers: { accept: "application/json" } });
          if (r.ok) { const d = await r.json(); if (Array.isArray(d)) { list = d; meteredCache = { at: Date.now(), list }; } }
        }
      }
      for (const s of list || []) {
        const urls = noPort53((Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === "string" && u.startsWith("turn")));
        if (urls.length && s.username && s.credential) { iceServers.push({ urls, username: s.username, credential: s.credential }); if (!via.includes("metered")) via.push("metered"); }
      }
    } catch {}
  }
  const urls = noPort53(splitUrls(env.TURN_URLS));
  if (urls.length && env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:u${user.id}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TURN_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)));
    iceServers.push({ urls, username, credential: btoa(String.fromCharCode(...sig)) }); via.push("coturn");
  } else if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }); via.push("static");
  }
  return { iceServers, turn: via.length > 0, via };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.protocol === "http:") { url.protocol = "https:"; return Response.redirect(url.toString(), 301); }
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, env, url, ctx);
      const res = await env.ASSETS.fetch(req);
      const isPage = req.method === "GET" && (res.headers.get("content-type") || "").includes("text/html");
      if (!isPage) return res;
      ctx.waitUntil(dir(env).logVisit(ctxOf(req), "video_visit").catch(() => {}));
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
      h.set("cache-control", "no-cache");
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      console.error(e && e.stack || e);
      return err(500, "服务器内部错误");
    }
  },
};

async function api(req, env, url, ctx) {
  const p = url.pathname, m = req.method, c = ctxOf(req), D = dir(env), token = getToken(req);
  if (m !== "GET" && m !== "HEAD" && !originOk(req, env)) return err(403, "来源不被允许");

  if (p === "/api/me" && m === "GET") {
    const user = await D.getSession(token);
    return user ? json({ user }) : err(401, "未登录");
  }
  if ((p === "/api/register" || p === "/api/login") && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = p === "/api/register" ? await D.register(b.username, b.password, c, b.code) : await D.login(b.username, b.password, c);
    if (!r.ok) return err(r.status, r.error);
    return json({ user: r.data.user }, 200, { "Set-Cookie": cookieHeader(env, r.data.token) });
  }
  if (p === "/api/reg-config" && m === "GET") return json(await D.regConfig());
  if (p === "/api/logout" && m === "POST") {
    if (token) await D.logout(token, c);
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(env, null) });
  }
  if (p === "/api/password" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.changePassword(token, b.oldPassword, b.newPassword, c));
  }

  if (p === "/api/avatar" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.setAvatar(token, b.avatar));
  }
  if (p === "/api/theme" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.setTheme(token, b.theme));
  }
  if (p === "/api/avatars" && m === "GET") {
    const map = await D.avatarsFor(token, (url.searchParams.get("names") || "").split(","));
    return map ? json({ avatars: map }) : err(401, "未登录");
  }

  // ICE 服务器：免费公共 STUN + 可选 TURN（全部由 Worker secret 配置，换服务商不用改代码，见 iceServersFor）
  if (p === "/api/ice" && m === "GET") {
    const user = await D.getSession(token);
    if (!user) return err(401, "未登录");
    const { iceServers, turn, via } = await iceServersFor(env, user);
    return json({ iceServers, turn, via });
  }

  if (p === "/api/rooms" && m === "GET") {
    const rows = await D.myRooms(token, "video");
    return rows ? json({ rooms: rows }) : err(401, "未登录");
  }
  if (p === "/api/rooms" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.createRoom(token, b.number, b.password, b.name, "video", c, b.visibility));
  }
  if (p === "/api/rooms/public" && m === "GET") {
    const rows = await D.publicRooms(token, "video");
    if (!rows) return err(401, "未登录");
    await Promise.all(rows.slice(0, 60).map(async (r) => { try { r.online = (await vroom(env, r.number).stats()).online.length; } catch { r.online = 0; } }));
    return json({ rooms: rows });
  }
  if (p === "/api/rooms/request" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = await D.requestJoin(token, b.number, "video", c);
    if (r.ok && r.data.created) await vroom(env, r.data.room).notifyUser(r.data.ownerId, { type: "join-request", id: r.data.id, username: r.data.username }).catch(() => {});
    return out(r);
  }
  if (p === "/api/rooms/requests" && m === "GET") return out(await D.listRequests(token, url.searchParams.get("number") || "", "video"));
  if (p === "/api/rooms/requests/decide" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.decideRequest(token, b.id, !!b.approve, c));
  }
  if (p === "/api/rooms/join" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.joinRoom(token, b.number, b.password, c, "video"));
  }
  if (p === "/api/rooms/close" && m === "POST") {
    // 房主（或管理员）关闭房间：删除登记，踢出所有人（前端收到后立即退出声网频道）
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = await D.closeRoom(token, b.number, "video", c);
    if (r.ok) await vroom(env, r.data.number).destroy(r.data.byOwner ? "房主已关闭房间" : "房间已被管理员关闭", true);
    return out(r);
  }
  if (p === "/api/rooms/leave" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    await D.leaveRoom(token, b.number, "video");
    return json({ ok: true });
  }
  // 声网 RTC Token（续期 / 调试用；进房时 WebSocket 的 welcome 里已经带了一个）：必须已凭密码加入该房间，且当前在房间里
  const mt = p.match(/^\/api\/rooms\/([^/]+)\/rtc-token$/);
  if (mt && m === "POST") {
    const user = await D.getSession(token);
    if (!user) return err(401, "未登录");
    const acc = await D.checkRoomAccess(token, decodeURIComponent(mt[1]), "video");
    if (!acc) return err(403, "无权进入该房间，请先用房间号和密码加入");
    const b = (await body(req)) || {};
    const rtc = await vroom(env, acc.room.number).rtcTokenFor(acc.user.id, typeof b.peerId === "string" ? b.peerId : null);
    if (!rtc) return err(409, "请先进入房间");
    if (rtc.error) return err(503, rtc.error);
    return json(rtc);
  }
  const mm = p.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (mm && m === "GET") {
    if (req.headers.get("Upgrade") !== "websocket") return err(426, "需要 WebSocket");
    if (!originOk(req, env)) return err(403, "来源不被允许");
    const number = decodeURIComponent(mm[1]);
    const acc = await D.checkRoomAccess(token, number, "video");
    if (!acc) return err(403, "无权进入该房间，请先用房间号和密码加入");
    ctx.waitUntil(D.roomEvent("video_connect", { ...c, userId: acc.user.id, username: acc.user.username, room: acc.room.number }).catch(() => {}));
    const h = new Headers({
      Upgrade: "websocket", "X-Uid": String(acc.user.id), "X-Username": encodeURIComponent(acc.user.username), "X-Room": acc.room.number,
      "X-Ip": c.ip, "X-Country": c.country, "X-UA": encodeURIComponent(c.ua.slice(0, 300).replace(/[\uD800-\uDFFF]/g, "")),
      "X-Owner": String(acc.room.creator_id ?? ""), "X-Owner-Name": encodeURIComponent(acc.room.creator_name || ""), "X-Visibility": acc.room.visibility || "private", "X-Room-Name": encodeURIComponent(acc.room.name || ""),
    });
    return vroom(env, acc.room.number).fetch("https://room/ws", { headers: h });
  }
  return err(404, "接口不存在");
}
