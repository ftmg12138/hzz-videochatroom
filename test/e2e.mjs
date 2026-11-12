// 视频聊天室端到端测试（线上）：node test/e2e.mjs
// 需要 ADMIN_PW_FILE（管理员初始密码文件，不打印）。管理员必须仍处于「初始密码 + 强制改密」状态，否则跳过后台部分。
// 结束时把管理员密码改回初始值；之后需运行 chatroom/scripts/reset-admin.sh 恢复强制改密。
import fs from "node:fs";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import zlib from "node:zlib";
import crypto from "node:crypto";
const V = process.env.BASE || "https://videochatroom.xyzhzz.com";
const C = process.env.CHAT_BASE || "https://chatroom.xyzhzz.com";
const MAINT = process.env.MAINT_TOKEN_FILE ? fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim() : null;
const ADMIN_PW = MAINT ? null : fs.readFileSync(process.env.ADMIN_PW_FILE || "/workspace/.secrets/chatroom-admin-init", "utf8").replace(/[\r\n]/g, "");
const sfx = Math.random().toString(36).slice(2, 7);
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓", name); } else { failN++; console.log("  ✗", name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 解析声网 AccessToken2（007）：不打印 Token；若本机有证书环境变量则顺便校验签名
function decodeToken(t) {
  const buf = zlib.inflateSync(Buffer.from(t.slice(3), "base64")); let o = 0;
  const u16 = () => { const v = buf.readUInt16LE(o); o += 2; return v; }, u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u16(); const b = buf.subarray(o, o + n); o += n; return b; };
  const sig = str(); const infoStart = o;
  const appId = str().toString(), issueTs = u32(), expire = u32(), salt = u32(), n = u16(); const svc = [];
  for (let i = 0; i < n; i++) { const type = u16(), np = u16(), privs = {}; for (let j = 0; j < np; j++) { const k = u16(); privs[k] = u32(); } svc.push({ type, privs, channel: str().toString(), uid: str().toString() }); }
  let sigOk = null; const cert = process.env.AGORA_APP_CERTIFICATE;
  if (cert) {
    const h = (k, m) => crypto.createHmac("sha256", k).update(m).digest(), le = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
    sigOk = h(h(le(salt), h(le(issueTs), cert)), buf.subarray(infoStart)).equals(sig);
  }
  return { v: t.slice(0, 3), appId, issueTs, expire, salt, svc, sigOk };
}

function client(base, extra = {}) {
  let cookie = "";
  return {
    get token() { return cookie.split("=")[1]; }, set cookie(v) { cookie = v; }, get cookie() { return cookie; },
    async req(path, method = "GET", body, b = base) {
      const h = { Origin: b, ...extra };
      if (cookie) h.Cookie = cookie;
      if (body !== undefined) h["content-type"] = "application/json";
      const r = await fetch(b + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get("set-cookie");
      if (sc) { const m = sc.match(/hzz_sid=([0-9a-f]*)/); cookie = m && m[1] ? `hzz_sid=${m[1]}` : ""; }
      let data = {}; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    },
    ws(room, b = base) {
      const ws = new WebSocket(b.replace(/^http/, "ws") + `/api/rooms/${encodeURIComponent(room)}/ws`, { headers: { Cookie: cookie, Origin: b } });
      ws.msgs = []; ws.on("message", (d) => ws.msgs.push(JSON.parse(d)));
      return ws;
    },
  };
}
const wsOpen = (ws) => new Promise((res) => { ws.once("open", () => res(true)); ws.once("unexpected-response", (_q, r) => res(r.statusCode)); ws.once("error", () => res(false)); });
async function waitFor(ws, pred, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const m = ws.msgs.find(pred); if (m) return m; await sleep(100); } return null; }

const a = client(V), b = client(V), anon = client(V), adm = client(C, MAINT ? { "X-Maint-Token": MAINT } : {});
const na = `va_${sfx}`, nb = `vb_${sfx}`, room = `vtest-${sfx}`, textRoom = `ttest-${sfx}`;
const PW = "Video-pass-" + sfx, RPW = "vr-" + sfx;
const ADMIN_TMP = "Tmp-Admin-" + Math.random().toString(36).slice(2) + "#5";

console.log("鉴权 / 房间");
let r = await anon.req("/api/me"); ok(r.status === 401, "未登录 /api/me 返回 401");
r = await anon.req("/api/ice"); ok(r.status === 401, "未登录不能获取 ICE 配置");
r = await anon.req("/api/rooms", "POST", { number: room, password: RPW }); ok(r.status === 401, "未登录不能创建房间");
r = await a.req("/api/register", "POST", { username: na, password: PW }); ok(r.status === 200, "视频站注册用户A");
r = await a.req("/api/me", "GET", undefined, C); ok(r.status === 200 && r.data.user.username === na, "同一 Cookie 在 chatroom 也是已登录（账号共享）");
r = await b.req("/api/register", "POST", { username: nb, password: PW }, C); ok(r.status === 200, "chatroom 注册用户B");
r = await b.req("/api/me"); ok(r.status === 200 && r.data.user.username === nb, "chatroom 账号在视频站可直接使用");
{ const sr = await fetch(V + "/vendor/AgoraRTC_N-4.24.9.js"); const txt = await sr.text(); ok(sr.status === 200 && txt.length > 1e6 && txt.includes("AgoraRTC"), `本站提供声网 Web SDK 4.24.9（${Math.round(txt.length / 1024)} KB）`); }
{ const hr = await fetch(V + "/"); const csp = hr.headers.get("content-security-policy") || ""; ok(/connect-src 'self' https: wss:/.test(csp) && /script-src 'self';/.test(csp), "CSP 允许连接声网（https/wss），脚本仍只允许本站"); }
r = await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "视频测试" }); ok(r.status === 200, "A 创建视频房间");
r = await a.req("/api/rooms", "POST", { number: textRoom, password: RPW }, C); ok(r.status === 200, "A 在 chatroom 创建文字房间");
r = await b.req("/api/rooms/join", "POST", { number: textRoom, password: RPW }); ok(r.status === 403, "文字房间号在视频站不存在（命名空间独立）");
r = await b.req("/api/rooms/join", "POST", { number: room, password: RPW }, C); ok(r.status === 403, "视频房间号在文字站不存在（命名空间独立）");
r = await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "同号文字房" }, C); ok(r.status === 200, "同一房间号可同时存在视频房和文字房");
r = await a.req("/api/rooms", "POST", { number: room, password: RPW }); ok(r.status === 409, "同类型同号房间不能重复创建");
let w = b.ws(room); ok((await wsOpen(w)) === 403, "未凭密码加入时信令 WebSocket 被拒"); w.terminate();
r = await anon.req(`/api/rooms/${room}/rtc-token`, "POST", {}); ok(r.status === 401, "未登录不能获取声网 Token");
r = await b.req(`/api/rooms/${room}/rtc-token`, "POST", {}); ok(r.status === 403, "未凭密码加入房间不能获取声网 Token");
r = await a.req(`/api/rooms/${room}/rtc-token`, "POST", {}); ok(r.status === 409, "未进入房间（无在线连接）时不签发声网 Token");
w = anon.ws(room); ok((await wsOpen(w)) === 403, "未登录信令 WebSocket 被拒"); w.terminate();
r = await b.req("/api/rooms/join", "POST", { number: room, password: "wrong-pw" }); ok(r.status === 403, "错误房间密码被拒");
r = await b.req("/api/rooms/join", "POST", { number: room, password: RPW }); ok(r.status === 200, "正确房间密码加入");
r = await fetch(V + "/api/rooms/join", { method: "POST", headers: { Origin: "https://evil.example", "content-type": "application/json", Cookie: b.cookie }, body: "{}" });
ok(r.status === 403, "跨站来源被拒");
// （本机禁止明文 HTTP 出站，HTTP→HTTPS 跳转由 Worker 代码处理，未在此测试）

console.log("声网 Token（信令 WebSocket）");
{
  const wa = a.ws(room); ok((await wsOpen(wa)) === true, "A 凭密码进入后信令 WebSocket 连接成功");
  const wel = await waitFor(wa, (m) => m.type === "welcome");
  const rtc = wel && wel.rtc;
  ok(rtc && /^[0-9a-f]{32}$/i.test(rtc.appId) && /^v_[0-9a-f]{24}$/.test(rtc.channel) && Number.isInteger(rtc.uid) && rtc.uid > 0 && rtc.uid === wel.rtcUid && /^007/.test(rtc.token), "welcome 带声网 App ID / 频道 / uid / Token（无证书）");
  ok(rtc && !JSON.stringify(wel).includes(process.env.AGORA_APP_CERTIFICATE || "\u0000none"), "下发内容不含 App 证书");
  const d = rtc ? decodeToken(rtc.token) : null;
  const sv = d && d.svc[0];
  ok(d && d.appId === rtc.appId && sv && sv.type === 1 && sv.channel === rtc.channel && sv.uid === String(rtc.uid) && [1, 2, 3, 4].every((k) => sv.privs[k] === d.expire) && d.expire >= 7200 && Math.abs(d.issueTs - Date.now() / 1000) < 120, "Token 解码：RTC 服务、频道/uid 匹配、发布者权限、2 小时有效");
  if (d && d.sigOk !== null) ok(d.sigOk === true, "Token 签名用证书校验通过（HMAC-SHA256）");
  r = await a.req(`/api/rooms/${room}/rtc-token`, "POST", { peerId: wel.you });
  ok(r.status === 200 && r.data.uid === rtc.uid && r.data.channel === rtc.channel && decodeToken(r.data.token).svc[0].uid === String(rtc.uid), "在房间内可经 HTTP 接口续签同一 uid 的 Token");
  r = await a.req(`/api/rooms/${room}/rtc-token`, "POST", { peerId: "nope0000" }); ok(r.status === 409, "peerId 不属于自己时不签发");
  wa.send(JSON.stringify({ type: "rtc-renew" }));
  const rn = await waitFor(wa, (m) => m.type === "rtc-token");
  ok(rn && rn.rtc && rn.rtc.uid === rtc.uid && /^007/.test(rn.rtc.token), "WebSocket rtc-renew 返回新 Token");
  const wa2 = a.ws(room); await wsOpen(wa2); const wel2 = await waitFor(wa2, (m) => m.type === "welcome");
  ok(wel2 && wel2.rtcUid !== rtc.uid && wel2.peers.some((p) => p.rtcUid === rtc.uid), "同一账号第二个连接分配不同 uid，成员列表带对方 uid");
  wa.close(); wa2.close(); await sleep(800);
}

console.log("声网音视频（无头 Chromium 假摄像头/麦克风，真实加入声网频道，启用站点 CSP）");
const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
async function pageFor(c, mobile) {
  const ctx = await br.newContext({ permissions: ["camera", "microphone"], ...(mobile ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 760 } }) });
  await ctx.addCookies([{ name: "hzz_sid", value: c.token, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const p = await ctx.newPage();
  p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  p.csp = []; p.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t) && !/cloudflareinsights/.test(t)) p.csp.push(t.slice(0, 160)); }); // Cloudflare 统计脚本本来就被 CSP 拦截，与本功能无关
  return p;
}
const agState = (p) => p.evaluate(() => window.__vc.agState + (window.__vc.rtcErr ? " / " + window.__vc.rtcErr : ""));
async function until(fn, ms = 20000) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(400); } return v; }
const remoteVideo = (p) => p.evaluate(() => [...document.querySelectorAll(".tile:not(.local) video")].map((v) => v.videoWidth));
const pa = await pageFor(a, false), pb = await pageFor(b, true);
await pa.goto(V + "/"); await pa.waitForSelector("#v-lobby:not(.hidden)");
ok(await pa.evaluate(() => !window.AgoraRTC), "大厅不加载声网 SDK（进房才加载）");
await pa.goto(V + "/#/room/" + room); await pa.waitForSelector("#v-perm:not(.hidden)");
ok(true, "进房前显示摄像头权限说明");
await pa.click("#p-allow"); await pa.waitForSelector("#v-room:not(.hidden)");
const sa = await until(async () => (await agState(pa)).startsWith("CONNECTED") && "CONNECTED", 25000);
ok(sa === "CONNECTED", `A 用服务端签发的 Token 加入声网频道成功（${await agState(pa)}）`);
await pb.goto(V + "/#/room/" + room); await pb.waitForSelector("#v-perm:not(.hidden)");
await pb.click("#p-allow"); await pb.waitForSelector("#v-room:not(.hidden)");
ok((await until(async () => (await agState(pb)).startsWith("CONNECTED"), 25000)), `B 加入声网频道成功（${await agState(pb)}）`);
let va = await until(async () => { const x = await remoteVideo(pa); return x.length === 1 && x[0] > 0 && x; }, 25000);
let vb = await until(async () => { const x = await remoteVideo(pb); return x.length === 1 && x[0] > 0 && x; }, 25000);
ok(!!va && !!vb, `双方经声网收到对方画面（A 收到宽 ${va && va[0]}，B 收到宽 ${vb && vb[0]}）`);
const audioA = await until(() => pa.evaluate(() => window.__vc.ag.remoteUsers.some((u) => u.audioTrack && u.hasAudio)), 10000);
ok(!!audioA, "A 订阅到 B 的音频");
ok(await pa.evaluate(() => { const t = document.querySelector('.tile:not(.local)'); return t.querySelector(".conn").classList.contains("hidden") && t.querySelector(".name span").textContent.length > 0; }), "远端画面对应到 B 的用户名，连接提示已消失");
const lv = await pa.evaluate(() => { const v = document.querySelector('.tile.local video'); return v && v.srcObject && v.srcObject.getVideoTracks().length; });
ok(lv === 1, "本地假摄像头画面已打开");
await pb.click("#b-mic"); await sleep(1500);
ok(await pa.evaluate(() => document.querySelector('.tile:not(.local) .mic').textContent === "🔇"), "B 静音后 A 端显示静音图标");
ok(await until(() => pa.evaluate(() => !window.__vc.ag.remoteUsers.some((u) => u.hasAudio)), 8000), "B 静音后不再发布音频");
await pb.click("#b-cam"); await sleep(1500);
ok(await pa.evaluate(() => !document.querySelector('.tile:not(.local) .off').classList.contains("hidden")), "B 关摄像头后 A 端显示头像占位");
await pb.click("#b-cam"); await pb.click("#b-mic");
ok(!!(await until(() => pa.evaluate(() => window.__vc.ag.remoteUsers.some((u) => u.hasAudio && u.hasVideo)), 12000)), "B 重新开麦/开摄像头后 A 再次收到音视频");
ok(!!(await until(async () => { const x = await remoteVideo(pa); return x[0] > 0; }, 12000)), "重新开摄像头后画面恢复");
// 第三人（A 的另一台设备，同账号）：不同 uid，不冲突；3 人时码率降到 300 kbps
const pa2 = await pageFor(a, false);
await pa2.goto(V + "/#/room/" + room); await pa2.waitForSelector("#v-perm:not(.hidden)"); await pa2.click("#p-allow"); await pa2.waitForSelector("#v-room:not(.hidden)");
ok(!!(await until(async () => { const x = await remoteVideo(pa2); return x.length === 2 && x.every((w) => w > 0); }, 30000)), "第三个设备（同账号）加入后收到另外两路画面");
ok(!!(await until(() => pa.evaluate(() => window.__vc.agV && window.__vc.agV._kb === 300 && window.__vc.ag.remoteUsers.length === 2), 8000)), "3 人时上行码率上限降到 300 kbps");
ok(await pa.evaluate(() => window.__vc.agState === "CONNECTED"), "A 未因同账号多设备被踢出声网频道");
await pa2.close();
await pa.click("#b-chat"); await pa.fill("#vr-input", "视频里的文字消息 👋"); await pa.press("#vr-input", "Enter");
await sleep(1200);
ok(await pb.evaluate(() => [...document.querySelectorAll("#vr-msgs .txt")].some((x) => x.textContent.includes("视频里的文字消息"))), "房间内文字聊天送达");
await pb.click("#b-chat"); await sleep(400);
await pa.screenshot({ path: "/workspace/video-shot-desktop.png" });
await pb.screenshot({ path: "/workspace/video-shot-mobile.png" });
ok(pa.errs.length === 0 && pb.errs.length === 0, "页面无 JS 报错" + (pa.errs.concat(pb.errs).length ? "：" + pa.errs.concat(pb.errs).join("; ") : ""));
ok(pa.csp.length === 0 && pb.csp.length === 0, "无 CSP 拦截" + (pa.csp.concat(pb.csp).length ? "：" + pa.csp.concat(pb.csp).slice(0, 3).join(" | ") : ""));
await pb.click('#vr-chat-close').catch(() => {});
await pb.click("#b-leave"); await pb.waitForSelector("#v-lobby:not(.hidden)");
ok(await pb.evaluate(() => window.__vc.ag === null), "B 离开房间时退出声网频道");
ok(!!(await until(() => pa.evaluate(() => window.__vc.peers.size === 0 && window.__vc.ag.remoteUsers.length === 0), 10000)), "B 离开后 A 端移除其画面");
await br.close();

// 满员测试：A 再用 4 个 WS 占位（浏览器已关闭）
const socks = [];
for (let i = 0; i < 4; i++) { const s = a.ws(room); await wsOpen(s); socks.push(s); }
const s5 = b.ws(room); await wsOpen(s5);
ok(!!(await waitFor(s5, (m) => m.type === "full")), "第 5 人进入时提示房间已满");
socks.forEach((s) => s.close()); s5.terminate();
await sleep(1000);

console.log("管理后台（chatroom /admin）");
r = MAINT ? { status: 200, data: { user: { mustChange: true } } } : await adm.req("/api/login", "POST", { username: "xyzhzzmaster", password: ADMIN_PW });
if (!(r.status === 200 && r.data.user.mustChange)) {
  console.log("  ! 管理员已不是初始密码状态，跳过后台检查（测试数据需手动清理）");
} else {
  if (!MAINT) { r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_PW, newPassword: ADMIN_TMP }); ok(r.status === 200, "临时改密进入后台"); }
  else { r = await adm.req("/api/admin/logs?limit=1"); ok(r.status === 200, "维护令牌进入后台（管理员密码未动）"); }
  r = await adm.req(`/api/admin/logs?scope=video&room=${room}&limit=200`);
  const evs = new Set(r.data.rows.map((x) => x.event));
  ok(r.status === 200 && ["video_room_create", "video_join", "video_join_fail", "video_connect", "video_leave"].every((e) => evs.has(e)), "视频事件写入访问日志：" + [...evs].join(","));
  ok(r.data.rows.every((x) => x.event.startsWith("video_")) && r.data.rows.some((x) => x.ip && x.event === "video_leave"), "视频筛选只含视频事件，离开事件带 IP");
  r = await adm.req(`/api/admin/logs?scope=text&room=${room}`); ok(r.status === 200 && r.data.rows.every((x) => !x.event.startsWith("video_")), "文字筛选不含视频事件");
  r = await adm.req(`/api/admin/logs?event=video_visit&limit=3`); ok(r.status === 200 && r.data.rows.length > 0, "视频站页面访问已记录");
  r = await adm.req("/api/admin/rooms?q=" + sfx);
  const vr = r.data.rows.find((x) => x.number === room && x.kind === "video"), tr = r.data.rows.find((x) => x.number === textRoom && x.kind === "text"), tr2 = r.data.rows.find((x) => x.number === room && x.kind === "text");
  ok(vr && vr.kind === "video" && vr.messages >= 1 && tr && tr2, "后台房间列表区分视频/文字（同号两种房间并存），并读取视频房间消息数");
  r = await adm.req(`/api/admin/rooms/video/${room}/messages`); ok(r.status === 200 && r.data.rows.some((x) => x.text.includes("视频里的文字消息")), "后台查看视频房间聊天");
  // 踢人 / 封禁
  const wb = b.ws(room); await wsOpen(wb); await waitFor(wb, (m) => m.type === "welcome");
  r = await adm.req("/api/admin/users?q=" + sfx);
  const idA = r.data.rows.find((x) => x.username === na).id, idB = r.data.rows.find((x) => x.username === nb).id;
  r = await adm.req(`/api/admin/users/${idB}/ban`, "POST", { banned: true, reason: "测试" });
  ok(r.status === 200 && !!(await waitFor(wb, (m) => m.type === "kicked")), "封禁用户会把他踢出视频房间");
  r = await b.req("/api/me"); ok(r.status === 401, "封禁后视频站会话失效");
  const wa = a.ws(room); await wsOpen(wa); await waitFor(wa, (m) => m.type === "welcome");
  r = await adm.req(`/api/admin/rooms/video/${room}/messages`, "DELETE"); ok(r.status === 200 && !!(await waitFor(wa, (m) => m.type === "chat-cleared")), "后台清空视频房间聊天");
  r = await adm.req(`/api/admin/rooms/video/${room}`, "DELETE"); ok(r.status === 200 && !!(await waitFor(wa, (m) => m.type === "kicked")), "删除视频房间并移出在线成员");
  wa.terminate(); wb.terminate();
  console.log("清理");
  r = await adm.req(`/api/admin/rooms/text/${textRoom}`, "DELETE"); ok(r.status === 200, "删除测试文字房间");
  r = await adm.req(`/api/admin/rooms/text/${room}`, "DELETE"); ok(r.status === 200, "删除同号测试文字房间");
  for (const id of [idA, idB]) { r = await adm.req(`/api/admin/users/${id}`, "DELETE"); ok(r.status === 200, "删除测试用户 " + id); }
  r = await adm.req("/api/admin/users?q=" + sfx); ok(r.data.rows.length === 0, "测试用户已清除");
  r = await adm.req("/api/admin/rooms?q=" + sfx); ok(r.data.rows.length === 0, "测试房间已清除");
  if (!MAINT) {
    r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_TMP, newPassword: ADMIN_PW }); ok(r.status === 200, "管理员密码改回初始值（随后运行 reset-admin.sh 恢复强制改密）");
    await adm.req("/api/logout", "POST");
  }
}
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
