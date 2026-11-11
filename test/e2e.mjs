// 视频聊天室端到端测试（线上）：node test/e2e.mjs
// 需要 ADMIN_PW_FILE（管理员初始密码文件，不打印）。管理员必须仍处于「初始密码 + 强制改密」状态，否则跳过后台部分。
// 结束时把管理员密码改回初始值；之后需运行 chatroom/scripts/reset-admin.sh 恢复强制改密。
import fs from "node:fs";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { nodePeer } from "./webrtc-node.mjs";
const V = process.env.BASE || "https://videochatroom.xyzhzz.com";
const C = process.env.CHAT_BASE || "https://chatroom.xyzhzz.com";
const ADMIN_PW = fs.readFileSync(process.env.ADMIN_PW_FILE || "/workspace/.secrets/chatroom-admin-init", "utf8").replace(/[\r\n]/g, "");
const sfx = Math.random().toString(36).slice(2, 7);
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓", name); } else { failN++; console.log("  ✗", name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  let cookie = "";
  return {
    get token() { return cookie.split("=")[1]; }, set cookie(v) { cookie = v; }, get cookie() { return cookie; },
    async req(path, method = "GET", body, b = base) {
      const h = { Origin: b };
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

const a = client(V), b = client(V), anon = client(V), adm = client(C);
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
r = await a.req("/api/ice"); ok(r.status === 200 && r.data.iceServers.length >= 1, `ICE 配置（TURN=${r.data.turn ? "有" : "无，仅 STUN"}）`);
const turn = r.data.turn;
r = await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "视频测试" }); ok(r.status === 200, "A 创建视频房间");
r = await a.req("/api/rooms", "POST", { number: textRoom, password: RPW }, C); ok(r.status === 200, "A 在 chatroom 创建文字房间");
r = await b.req("/api/rooms/join", "POST", { number: textRoom, password: RPW }); ok(r.status === 400, "文字房间号不能在视频站加入");
r = await b.req("/api/rooms/join", "POST", { number: room, password: RPW }, C); ok(r.status === 400, "视频房间号不能在文字站加入");
let w = b.ws(room); ok((await wsOpen(w)) === 403, "未凭密码加入时信令 WebSocket 被拒"); w.terminate();
w = anon.ws(room); ok((await wsOpen(w)) === 403, "未登录信令 WebSocket 被拒"); w.terminate();
r = await b.req("/api/rooms/join", "POST", { number: room, password: "wrong-pw" }); ok(r.status === 403, "错误房间密码被拒");
r = await b.req("/api/rooms/join", "POST", { number: room, password: RPW }); ok(r.status === 200, "正确房间密码加入");
r = await fetch(V + "/api/rooms/join", { method: "POST", headers: { Origin: "https://evil.example", "content-type": "application/json", Cookie: b.cookie }, body: "{}" });
ok(r.status === 403, "跨站来源被拒");
// （本机禁止明文 HTTP 出站，HTTP→HTTPS 跳转由 Worker 代码处理，未在此测试）

console.log("WebRTC（两个无头 Chromium，假摄像头/麦克风）");
const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required"] });
async function pageFor(c, mobile) {
  const ctx = await br.newContext({ bypassCSP: true, permissions: ["camera", "microphone"], ...(mobile ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 760 } }) });
  await ctx.addCookies([{ name: "hzz_sid", value: c.token, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const p = await ctx.newPage();
  p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  return p;
}
const pa = await pageFor(a, false), pb = await pageFor(b, true);
await pa.goto(V + "/"); await pa.waitForSelector("#v-lobby:not(.hidden)");
ok(true, "A 打开大厅");
await pa.goto(V + "/#/room/" + room); await pa.waitForSelector("#v-perm:not(.hidden)");
ok(true, "进房前显示摄像头权限说明");
await pa.screenshot({ path: "/workspace/video-shot-perm.png" });
await pa.click("#p-allow"); await pa.waitForSelector("#v-room:not(.hidden)");
await pb.goto(V + "/#/room/" + room); await pb.waitForSelector("#v-perm:not(.hidden)");
await pb.click("#p-allow"); await pb.waitForSelector("#v-room:not(.hidden)");
const conn = (p) => p.evaluate(() => [...window.__vc.peers.values()].map((x) => x.pc.connectionState));
const sig = (p) => p.evaluate(() => [...window.__vc.peers.values()].map((x) => `${x.pc.signalingState}/${x.pc.remoteDescription ? x.pc.remoteDescription.type : "-"}`));
let sa = [], sb = [];
for (let i = 0; i < 20; i++) { sa = await sig(pa); sb = await sig(pb); if (sa[0]?.startsWith("stable/") && sb[0]?.startsWith("stable/")) break; await sleep(300); }
ok(sa.length === 1 && sa[0] === "stable/offer" && sb[0] === "stable/answer", `Chrome 两端经信令完成 offer/answer（A=${sa} B=${sb}）`);
const lv = await pa.evaluate(() => { const v = document.querySelector('.tile.local video'); return v && v.srcObject && v.srcObject.getVideoTracks().length; });
ok(lv === 1, "本地假摄像头画面已打开");
console.log("    Chrome ICE 状态（受本机策略限制不产生候选，仅供参考）：A=" + (await conn(pa)) + " B=" + (await conn(pb)));
const audioIn = await pa.evaluate(() => [...window.__vc.peers.values()][0].stream.getAudioTracks().length);
ok(audioIn === 1, "收到对方音轨");
await pb.click("#b-mic");
await sleep(1200);
ok(await pa.evaluate(() => document.querySelector('.tile:not(.local) .mic').textContent === "🔇"), "B 静音后 A 端显示静音图标");
await pb.click("#b-cam"); await sleep(1200);
ok(await pa.evaluate(() => !document.querySelector('.tile:not(.local) .off').classList.contains("hidden")), "B 关摄像头后 A 端显示头像占位");
await pb.click("#b-cam"); await pb.click("#b-mic"); await sleep(800);
await pa.click("#b-chat"); await pa.fill("#vr-input", "视频里的文字消息 👋"); await pa.press("#vr-input", "Enter");
await sleep(1200);
ok(await pb.evaluate(() => [...document.querySelectorAll("#vr-msgs .txt")].some((x) => x.textContent.includes("视频里的文字消息"))), "房间内文字聊天送达");
await pb.click("#b-chat"); await sleep(400);
await pa.screenshot({ path: "/workspace/video-shot-desktop.png" });
await pb.screenshot({ path: "/workspace/video-shot-mobile.png" });
ok(pa.errs.length === 0 && pb.errs.length === 0, "页面无 JS 报错" + (pa.errs.concat(pb.errs).length ? "：" + pa.errs.concat(pb.errs).join("; ") : ""));
// B 离开
await pb.click('#vr-chat-close').catch(() => {});
await pb.click("#b-leave"); await pb.waitForSelector("#v-lobby:not(.hidden)");
await sleep(1500);
ok((await conn(pa)).length === 0, "B 离开后 A 端移除其画面");
await br.close();

console.log("WebRTC（werift 纯 JS 客户端，经线上信令建立连接）");
{
  const n1 = nodePeer(V, a.cookie, room); ok((await n1.opened) === true, "节点客户端1 进入房间");
  await sleep(800);
  const n2 = nodePeer(V, b.cookie, room); ok((await n2.opened) === true, "节点客户端2 进入房间");
  let s1 = [], s2 = [];
  for (let i = 0; i < 40; i++) { s1 = n1.states(); s2 = n2.states(); if (s1[0] === "connected" && s2[0] === "connected") break; await sleep(500); }
  ok(s1[0] === "connected" && s2[0] === "connected", `经线上信令完成 ICE，两端 connected（1=${s1} 2=${s2}）`);
  await n1.close(); await n2.close(); await sleep(800);
}

// 满员测试：A 再用 4 个 WS 占位（A 浏览器已关闭）
const socks = [];
for (let i = 0; i < 4; i++) { const s = a.ws(room); await wsOpen(s); socks.push(s); }
const s5 = b.ws(room); await wsOpen(s5);
ok(!!(await waitFor(s5, (m) => m.type === "full")), "第 5 人进入时提示房间已满");
socks.forEach((s) => s.close()); s5.terminate();
await sleep(1000);

console.log("管理后台（chatroom /admin）");
r = await adm.req("/api/login", "POST", { username: "xyzhzzmaster", password: ADMIN_PW });
if (!(r.status === 200 && r.data.user.mustChange)) {
  console.log("  ! 管理员已不是初始密码状态，跳过后台检查（测试数据需手动清理）");
} else {
  r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_PW, newPassword: ADMIN_TMP }); ok(r.status === 200, "临时改密进入后台");
  r = await adm.req(`/api/admin/logs?scope=video&room=${room}&limit=200`);
  const evs = new Set(r.data.rows.map((x) => x.event));
  ok(r.status === 200 && ["video_room_create", "video_join", "video_join_fail", "video_connect", "video_leave"].every((e) => evs.has(e)), "视频事件写入访问日志：" + [...evs].join(","));
  ok(r.data.rows.every((x) => x.event.startsWith("video_")) && r.data.rows.some((x) => x.ip && x.event === "video_leave"), "视频筛选只含视频事件，离开事件带 IP");
  r = await adm.req(`/api/admin/logs?scope=text&room=${room}`); ok(r.status === 200 && r.data.rows.every((x) => !x.event.startsWith("video_")), "文字筛选不含视频事件");
  r = await adm.req(`/api/admin/logs?event=video_visit&limit=3`); ok(r.status === 200 && r.data.rows.length > 0, "视频站页面访问已记录");
  r = await adm.req("/api/admin/rooms?q=" + sfx);
  const vr = r.data.rows.find((x) => x.number === room), tr = r.data.rows.find((x) => x.number === textRoom);
  ok(vr && vr.kind === "video" && vr.messages >= 1 && tr && tr.kind === "text", "后台房间列表区分视频/文字，并读取视频房间消息数");
  r = await adm.req(`/api/admin/rooms/${room}/messages`); ok(r.status === 200 && r.data.rows.some((x) => x.text.includes("视频里的文字消息")), "后台查看视频房间聊天");
  // 踢人 / 封禁
  const wb = b.ws(room); await wsOpen(wb); await waitFor(wb, (m) => m.type === "welcome");
  r = await adm.req("/api/admin/users?q=" + sfx);
  const idA = r.data.rows.find((x) => x.username === na).id, idB = r.data.rows.find((x) => x.username === nb).id;
  r = await adm.req(`/api/admin/users/${idB}/ban`, "POST", { banned: true, reason: "测试" });
  ok(r.status === 200 && !!(await waitFor(wb, (m) => m.type === "kicked")), "封禁用户会把他踢出视频房间");
  r = await b.req("/api/me"); ok(r.status === 401, "封禁后视频站会话失效");
  const wa = a.ws(room); await wsOpen(wa); await waitFor(wa, (m) => m.type === "welcome");
  r = await adm.req(`/api/admin/rooms/${room}/messages`, "DELETE"); ok(r.status === 200 && !!(await waitFor(wa, (m) => m.type === "chat-cleared")), "后台清空视频房间聊天");
  r = await adm.req(`/api/admin/rooms/${room}`, "DELETE"); ok(r.status === 200 && !!(await waitFor(wa, (m) => m.type === "kicked")), "删除视频房间并移出在线成员");
  wa.terminate(); wb.terminate();
  console.log("清理");
  r = await adm.req(`/api/admin/rooms/${textRoom}`, "DELETE"); ok(r.status === 200, "删除测试文字房间");
  for (const id of [idA, idB]) { r = await adm.req(`/api/admin/users/${id}`, "DELETE"); ok(r.status === 200, "删除测试用户 " + id); }
  r = await adm.req("/api/admin/users?q=" + sfx); ok(r.data.rows.length === 0, "测试用户已清除");
  r = await adm.req("/api/admin/rooms?q=" + sfx); ok(r.data.rows.length === 0, "测试房间已清除");
  r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_TMP, newPassword: ADMIN_PW }); ok(r.status === 200, "管理员密码改回初始值（随后运行 reset-admin.sh 恢复强制改密）");
  await adm.req("/api/logout", "POST");
}
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
