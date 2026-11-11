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

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

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
    const r = p === "/api/register" ? await D.register(b.username, b.password, c) : await D.login(b.username, b.password, c);
    if (!r.ok) return err(r.status, r.error);
    return json({ user: r.data.user }, 200, { "Set-Cookie": cookieHeader(env, r.data.token) });
  }
  if (p === "/api/logout" && m === "POST") {
    if (token) await D.logout(token, c);
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(env, null) });
  }
  if (p === "/api/password" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.changePassword(token, b.oldPassword, b.newPassword, c));
  }

  // ICE 服务器：STUN 免费公共；若配置了 Cloudflare Realtime TURN 密钥（secret），在服务端签发短期凭据
  if (p === "/api/ice" && m === "GET") {
    const user = await D.getSession(token);
    if (!user) return err(401, "未登录");
    const iceServers = [...STUN];
    let turn = false;
    if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: 6 * 3600 }),
        });
        if (r.ok) {
          const d = await r.json();
          const list = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
          // 去掉 53 端口（浏览器常被拦），保留 TURN 部分
          for (const s of list) {
            const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
            if (urls.some((u) => u.startsWith("turn"))) { iceServers.push({ ...s, urls: urls.filter((u) => u.startsWith("turn")) }); turn = true; }
          }
        }
      } catch {}
    }
    return json({ iceServers, turn });
  }

  if (p === "/api/rooms" && m === "GET") {
    const rows = await D.myRooms(token, "video");
    return rows ? json({ rooms: rows }) : err(401, "未登录");
  }
  if (p === "/api/rooms" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.createRoom(token, b.number, b.password, b.name, "video", c));
  }
  if (p === "/api/rooms/join" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.joinRoom(token, b.number, b.password, c, "video"));
  }
  if (p === "/api/rooms/leave" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    await D.leaveRoom(token, b.number);
    return json({ ok: true });
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
      Upgrade: "websocket", "X-Uid": String(acc.user.id), "X-Username": acc.user.username, "X-Room": acc.room.number,
      "X-Ip": c.ip, "X-Country": c.country, "X-UA": c.ua.slice(0, 300),
    });
    return vroom(env, acc.room.number).fetch("https://room/ws", { headers: h });
  }
  return err(404, "接口不存在");
}
