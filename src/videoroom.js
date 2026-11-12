// VideoRoom：每个视频房间一个 Durable Object。
// 负责成员进出（含每人的声网 uid）、签发声网 RTC Token、媒体状态广播、房间内文字聊天（SQLite 持久化）。
// 音视频本身走声网 Agora RTC（见 public/app.js），不再浏览器点对点直连。
import { DurableObject } from "cloudflare:workers";
import { buildRtcToken, channelFor } from "./agora.js";

const MAX_LEN = 1000;
const HISTORY = 50;
const KEEP = 2000;
export const RTC_TTL = 2 * 3600; // 声网 Token 有效期（秒）；客户端在过期前 30 秒经 WebSocket 续期

export class VideoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
    this.rate = new Map();
  }
  init() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER, username TEXT,
      text TEXT NOT NULL, ip TEXT, kind TEXT NOT NULL DEFAULT 'msg');`);
  }
  peers() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1)
      .map((ws) => ({ ws, a: ws.deserializeAttachment() || {} })).filter((p) => p.a.peerId);
  }
  online() { return [...new Set(this.peers().map((p) => p.a.username))].sort(); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj, exceptPeer) {
    const s = JSON.stringify(obj);
    for (const p of this.peers()) if (p.a.peerId !== exceptPeer) { try { p.ws.send(s); } catch {} }
  }
  history() {
    return this.sql.exec("SELECT id, ts, username, text, kind FROM messages ORDER BY id DESC LIMIT ?", HISTORY).toArray().reverse();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = Number(request.headers.get("X-Uid"));
    const username = decodeURIComponent(request.headers.get("X-Username") || "");
    const room = request.headers.get("X-Room");
    const ip = request.headers.get("X-Ip") || "";
    const country = request.headers.get("X-Country") || "";
    const ua = decodeURIComponent(request.headers.get("X-UA") || "");
    const max = Number(this.env.MAX_PEERS || 4);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`u:${uid}`]);
    if (this.peers().length >= max) {
      server.serializeAttachment({});
      this.send(server, { type: "full", error: `房间已满（最多 ${max} 人）` });
      server.close(4009, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const peerId = crypto.randomUUID().slice(0, 8);
    // 声网 uid：每个连接一个，由服务器分配（客户端无法冒用别人的 uid），用于把声网的远端画面对应到用户名/头像
    const used = new Set(this.peers().map((p) => p.a.rtcUid));
    let rtcUid; do { rtcUid = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) || 1; } while (used.has(rtcUid));
    const existing = this.peers().map((p) => ({ peerId: p.a.peerId, username: p.a.username, rtcUid: p.a.rtcUid, state: p.a.state || {} }));
    server.serializeAttachment({ uid, username, ip, country, ua, room, peerId, rtcUid, state: { audio: true, video: true, screen: false }, joinedAt: Date.now() });
    const ownerId = Number(request.headers.get("X-Owner")) || null;
    this.send(server, { type: "welcome", room, you: peerId, me: username, rtcUid, rtc: await this.rtcFor(room, rtcUid), peers: existing, history: this.history(), max,
      owner: decodeURIComponent(request.headers.get("X-Owner-Name") || ""), isOwner: ownerId === uid, visibility: request.headers.get("X-Visibility") || "private",
      name: decodeURIComponent(request.headers.get("X-Room-Name") || "") });
    this.broadcast({ type: "peer-join", peerId, username, rtcUid }, peerId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment() || {};
    if (!a.peerId) return;
    if (typeof raw !== "string" || raw.length > 64 * 1024) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "ping": this.send(ws, { type: "pong" }); return;
      case "rtc-renew": // 声网 Token 即将过期：只给仍在房间里的连接续签
        this.send(ws, { type: "rtc-token", rtc: await this.rtcFor(a.room, a.rtcUid) });
        return;
      case "state": {
        a.state = { audio: !!m.audio, video: !!m.video, screen: !!m.screen };
        ws.serializeAttachment(a);
        this.broadcast({ type: "peer-state", peerId: a.peerId, state: a.state }, a.peerId);
        return;
      }
      case "chat": {
        const text = String(m.text || "").replace(/\r\n/g, "\n").trim();
        if (!text) return;
        if (text.length > MAX_LEN) return this.send(ws, { type: "error", error: `消息过长（最多 ${MAX_LEN} 字）` });
        const now = Date.now();
        const arr = (this.rate.get(a.uid) || []).filter((t) => now - t < 10000);
        if (arr.length >= 15) return this.send(ws, { type: "error", error: "发送太快了，稍等一下" });
        arr.push(now); this.rate.set(a.uid, arr);
        this.sql.exec("INSERT INTO messages(ts,user_id,username,text,ip) VALUES(?,?,?,?,?)", now, a.uid, a.username, text, a.ip);
        const id = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
        if (id % 200 === 0) this.sql.exec("DELETE FROM messages WHERE id <= ?", id - KEEP);
        this.broadcast({ type: "chat", msg: { id, ts: now, username: a.username, text, kind: "msg" } });
        return;
      }
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
    this.left(ws);
  }
  async webSocketError(ws) { this.left(ws); }
  left(ws) {
    const a = ws.deserializeAttachment() || {};
    if (!a.peerId || a.leftLogged) return;
    a.leftLogged = true;
    try { ws.serializeAttachment(a); } catch {}
    this.broadcast({ type: "peer-leave", peerId: a.peerId, username: a.username });
    const secs = a.joinedAt ? Math.round((Date.now() - a.joinedAt) / 1000) : null;
    this.ctx.waitUntil(this.dir().roomEvent("video_leave", {
      userId: a.uid, username: a.username, room: a.room, ip: a.ip, country: a.country, ua: a.ua,
      path: "videochatroom", detail: secs != null ? `停留 ${secs} 秒` : null,
    }).catch(() => {}));
  }
  dir() { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("main")); }

  // 声网 RTC 参数：App ID（公开）、频道名、uid、Token。证书只在服务端使用。
  async rtcFor(room, rtcUid) {
    if (!this.env.AGORA_APP_ID || !this.env.AGORA_APP_CERTIFICATE) return { error: "视频服务未配置（缺少声网 App ID / 证书）" };
    try {
      const channel = await channelFor(room);
      const token = await buildRtcToken(this.env.AGORA_APP_ID, this.env.AGORA_APP_CERTIFICATE, channel, rtcUid, RTC_TTL);
      return { appId: this.env.AGORA_APP_ID, channel, uid: rtcUid, token, expiresIn: RTC_TTL };
    } catch (e) { return { error: "视频服务配置错误：" + (e && e.message) }; }
  }
  // 供 /api/rooms/:n/rtc-token 调用：只给该用户当前在线的连接签发（peerId 可选，用于同一账号多设备）
  async rtcTokenFor(userId, peerId) {
    const p = this.peers().find((x) => x.a.uid === Number(userId) && (!peerId || x.a.peerId === peerId));
    if (!p) return null;
    return this.rtcFor(p.a.room, p.a.rtcUid);
  }

  // ---------- 管理 RPC（与 ChatRoom 同名，供 chatroom 后台调用） ----------
  async adminMessages(limit = 300, afterId = 0) {
    return this.sql.exec("SELECT id, ts, username, text, ip, kind FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?", Number(afterId) || 0, Math.min(limit, 1000)).toArray();
  }
  async stats() {
    const members = this.peers().map((p) => ({ uid: p.a.uid, rtcUid: p.a.rtcUid, username: p.a.username, ip: p.a.ip, country: p.a.country, video: !!p.a.state?.video, audio: !!p.a.state?.audio, screen: !!p.a.state?.screen }));
    return { messages: this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n, lastMsgAt: this.sql.exec("SELECT MAX(ts) AS t FROM messages").one().t || null,
             online: this.online(), video: members.map((m) => m.username), members };
  }
  async notifyUser(uid, obj) {
    for (const ws of this.ctx.getWebSockets(`u:${uid}`)) this.send(ws, obj);
    return true;
  }
  async deleteMessage(id) {
    this.sql.exec("DELETE FROM messages WHERE id=?", Number(id));
    this.broadcast({ type: "chat-deleted", id: Number(id) });
    return true;
  }
  async clearMessages() {
    this.sql.exec("DELETE FROM messages");
    this.broadcast({ type: "chat-cleared" });
    return true;
  }
  async kickUser(uid, reason = "你已被移出房间") {
    for (const ws of this.ctx.getWebSockets(`u:${uid}`)) {
      this.send(ws, { type: "kicked", reason });
      this.left(ws);
      try { ws.close(4003, "kicked"); } catch {}
    }
    return true;
  }
  async destroy(reason = "房间已被管理员删除", closed = false) {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { type: "kicked", reason, closed });
      this.left(ws);
      try { ws.close(4004, "room deleted"); } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.init();
    return true;
  }
}
