// 连接健壮性测试（线上后端）：看门狗 ICE restart、放弃后「点击重试」两端重建、完美协商（双方同时 offer）、码率/采集限制。
// 本机 Chrome 受策略限制无法产生 ICE 候选，正好用来模拟「永远连不上」。
// 用法：MAINT_TOKEN_FILE=... [LOCAL=1] node test/restart.mjs   （LOCAL=1：用本地 public/app.js、style.css 替换线上文件，部署前验证）
import fs from "node:fs";
import { chromium } from "playwright-core";
import { nodePeer } from "./webrtc-node.mjs";
const V = process.env.BASE || "https://videochatroom.xyzhzz.com";
const C = "https://chatroom.xyzhzz.com";
const MAINT = fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim();
const sfx = Math.random().toString(36).slice(2, 7);
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓", name); } else { failN++; console.log("  ✗", name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base, extra = {}) {
  let cookie = "";
  return {
    get token() { return cookie.split("=")[1]; }, get cookie() { return cookie; },
    async req(path, method = "GET", body, b = base) {
      const h = { Origin: b, ...extra }; if (cookie) h.Cookie = cookie; if (body !== undefined) h["content-type"] = "application/json";
      const r = await fetch(b + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/hzz_sid=([0-9a-f]*)/); cookie = m && m[1] ? `hzz_sid=${m[1]}` : ""; }
      let data = {}; try { data = await r.json(); } catch {} return { status: r.status, data };
    },
  };
}
const a = client(V), b = client(V), adm = client(C, { "X-Maint-Token": MAINT });
const na = `rs_a_${sfx}`, nb = `rs_b_${sfx}`, room = `rtest-${sfx}`, PW = "Restart-pass-" + sfx, RPW = "rr-" + sfx;
let br, n3;
try {
  console.log("准备");
  ok((await a.req("/api/register", "POST", { username: na, password: PW })).status === 200, "注册测试用户A");
  ok((await b.req("/api/register", "POST", { username: nb, password: PW })).status === 200, "注册测试用户B");
  const ice = await a.req("/api/ice"); ok(ice.status === 200 && Array.isArray(ice.data.iceServers) && "via" in ice.data, `/api/ice 正常（turn=${ice.data.turn}，via=${JSON.stringify(ice.data.via)}）`);
  ok(JSON.stringify(ice.data).length < 2000 && !/TURN_|apiKey|secret/i.test(JSON.stringify(ice.data)), "/api/ice 不含密钥字段");
  ok((await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "重连测试" })).status === 200, "A 创建房间");
  ok((await b.req("/api/rooms/join", "POST", { number: room, password: RPW })).status === 200, "B 加入房间");

  br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  async function pageFor(c) {
    const ctx = await br.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1100, height: 720 } });
    await ctx.addCookies([{ name: "hzz_sid", value: c.token, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    await ctx.addInitScript(() => { window.__vcCfg = { connectMs: 3000, discMs: 1500, maxRestarts: 3 }; });
    if (process.env.LOCAL) for (const f of ["app.js", "style.css"]) await ctx.route(new RegExp(`/${f.replace(".", "\\.")}(\\?|$)`), (r) => r.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/css", body: fs.readFileSync("public/" + f) }));
    const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    p.logs = []; p.on("console", (m) => p.logs.push(m.text()));
    return p;
  }
  const pa = await pageFor(a), pb = await pageFor(b);
  for (const p of [pa, pb]) { await p.goto(V + "/#/room/" + room); await p.waitForSelector("#v-perm:not(.hidden)"); await p.click("#p-allow"); await p.waitForSelector("#v-room:not(.hidden)"); await sleep(1200); }
  const info = (p) => p.evaluate(() => [...window.__vc.peers.values()].map((x) => ({
    sig: x.pc.signalingState, conn: x.pc.connectionState, init: x.initiator, polite: x.polite, restarts: x.restarts, resets: x.resets, gaveUp: x.gaveUp,
    lu: (x.pc.localDescription?.sdp.match(/a=ice-ufrag:(\S+)/) || [])[1], ru: (x.pc.remoteDescription?.sdp.match(/a=ice-ufrag:(\S+)/) || [])[1],
    badge: x.tile.querySelector(".conn").textContent, badgeHidden: x.tile.querySelector(".conn").classList.contains("hidden"),
    tx: x.pc.getTransceivers().filter((t) => t.mid !== null).length,
    br: x.pc.getTransceivers().filter((t) => t.mid !== null && t.receiver.track.kind === "video").map((t) => t.sender.getParameters().encodings?.[0]?.maxBitrate),
  })));
  const waitInfo = async (p, pred, ms = 8000) => { const t = Date.now(); let i; while (Date.now() - t < ms) { i = await info(p); if (pred(i)) return i; await sleep(200); } return i; };
  console.log("首次协商 + 码率");
  let ia = await waitInfo(pa, (i) => i[0]?.sig === "stable" && i[0]?.ru), ib = await waitInfo(pb, (i) => i[0]?.sig === "stable" && i[0]?.ru);
  ok(ib[0].init && !ia[0].init && ia[0].polite !== ib[0].polite, `后进者 B 发起，polite 两端相反（A polite=${ia[0].polite}）`);
  ok(ia[0].lu === ib[0].ru && ib[0].lu === ia[0].ru && ia[0].tx === 2 && ib[0].tx === 2, "offer/answer 完成，两端 ufrag 对上，各 2 路收发器");
  ia = await waitInfo(pa, (i) => i[0]?.br[0] === 500000); ib = await waitInfo(pb, (i) => i[0]?.br[0] === 500000);
  ok(ia[0].br[0] === 500000 && ib[0].br[0] === 500000, `2 人时视频上行限速 500 kbps（A=${ia[0].br} B=${ib[0].br}）`);
  const deg = await pa.evaluate(() => [...window.__vc.peers.values()][0].pc.getSenders().find((s) => s.track?.kind === "video")?.getParameters().degradationPreference);
  console.log("    degradationPreference =", deg);
  const conn0 = ia[0].conn;
  console.log("    Chrome 连接状态（本机无 ICE 候选，预期连不上）：", conn0);

  if (conn0 !== "connected") {
    console.log("看门狗 ICE restart（connectMs=3s，最多 3 次）");
    const u0 = ia[0].ru;
    ib = await waitInfo(pb, (i) => i[0]?.restarts >= 1, 6000);
    ia = await waitInfo(pa, (i) => i[0]?.ru && i[0].ru !== u0, 4000);
    ok(ib[0].restarts >= 1 && ia[0].ru !== u0, `发起方 B 超时后做 ICE restart，A 收到新 ufrag（restarts=${ib[0].restarts}）`);
    ia = await waitInfo(pa, (i) => i[0]?.gaveUp, 20000); ib = await waitInfo(pb, (i) => i[0]?.gaveUp, 3000);
    ok(ib[0].restarts === 3 && ib[0].gaveUp && ia[0].gaveUp, `3 次重试后两端都放弃（B restarts=${ib[0].restarts}）`);
    ok(ia[0].badge === "连接失败，点击重试" && !ia[0].badgeHidden && ib[0].badge === "连接失败，点击重试", "两端画面显示「连接失败，点击重试」");
    await pa.screenshot({ path: "/workspace/video-shot-retry.png" });
    console.log("点击重试 → 两端重建");
    await pa.click(".tile:not(.local) .conn.retry");
    ia = await waitInfo(pa, (i) => i[0]?.resets === 1 && i[0].sig === "stable" && i[0].ru); ib = await waitInfo(pb, (i) => i[0]?.resets === 1 && i[0].sig === "stable" && i[0].ru);
    ok(ia[0].resets === 1 && ib[0].resets === 1, "两端都重建了 RTCPeerConnection");
    ok(ia[0].init && !ib[0].init && !ia[0].gaveUp && !ib[0].gaveUp && ia[0].badge === "连接中", "点击方 A 变为发起方，状态回到「连接中」");
    ok(ia[0].lu === ib[0].ru && ib[0].lu === ia[0].ru && ia[0].tx === 2 && ib[0].tx === 2, "重建后协商完成（ufrag 对上，2 路收发器）");
  } else console.log("  ! Chrome 已直接连通，跳过看门狗测试");

  console.log("完美协商：两端同时发 offer（glare）");
  await Promise.all([pa, pb].map((p) => p.evaluate(() => { const x = [...window.__vc.peers.values()][0]; x.pc.restartIce(); })));
  await sleep(2500);
  ia = await waitInfo(pa, (i) => i[0]?.sig === "stable"); ib = await waitInfo(pb, (i) => i[0]?.sig === "stable");
  ok(ia[0].sig === "stable" && ib[0].sig === "stable" && ia[0].lu === ib[0].ru && ib[0].lu === ia[0].ru, `冲突后两端回到 stable 且 ufrag 一致（A ${ia[0].lu}/${ia[0].ru}，B ${ib[0].lu}/${ib[0].ru}）`);
  ok(ia[0].tx === 2 && ib[0].tx === 2, "冲突处理后仍是 2 路收发器（没有多出 m-line）");
  // 两端各自同时新建连接（双方都当发起方）的极端情况：同时点重试
  await Promise.all([pa, pb].map((p) => p.evaluate(() => { const x = [...window.__vc.peers.values()][0]; x.gaveUp = true; x.tile.querySelector(".conn").click(); })));
  for (let t = 0; t < 40; t++) { await sleep(250); ia = await info(pa); ib = await info(pb); if (t > 8 && ia[0]?.sig === "stable" && ib[0]?.sig === "stable" && ia[0].lu === ib[0].ru && ib[0].lu === ia[0].ru) break; }
  ok(ia[0].lu === ib[0].ru && ib[0].lu === ia[0].ru && ia[0].init !== ib[0].init && ia[0].tx === 2 && ib[0].tx === 2, `双方同时点重试也能收敛（A init=${ia[0].init} B init=${ib[0].init}）`); if (failN) console.log(JSON.stringify({ ia, ib }));

  console.log("3 人：码率 300 kbps、采集降到 480x360@20");
  n3 = nodePeer(V, a.cookie, room); ok((await n3.opened) === true, "第三个成员（werift）进入");
  ia = await waitInfo(pa, (i) => i.length === 2 && i.every((x) => x.br[0] === 300000), 10000);
  ok(ia.length === 2 && ia.every((x) => x.br[0] === 300000), `3 人时每路视频 300 kbps（A=${ia.map((x) => x.br)}）`);
  const cs = await pa.evaluate(() => { const s = window.__vc.cam.getSettings(); return `${s.width}x${s.height}@${s.frameRate}`; });
  ok(/^480x360@20/.test(cs), "A 摄像头采集降为 " + cs);
  await n3.close(); n3 = null;
  ia = await waitInfo(pa, (i) => i.length === 1 && i[0].br[0] === 500000, 8000);
  const cs2 = await pa.evaluate(() => { const s = window.__vc.cam.getSettings(); return `${s.width}x${s.height}@${s.frameRate}`; });
  ok(ia.length === 1 && ia[0].br[0] === 500000 && /^640x480/.test(cs2), `第三人离开后恢复 500 kbps / ${cs2}`);
  ok(pa.errs.length === 0 && pb.errs.length === 0, "页面无 JS 报错" + (pa.errs.concat(pb.errs).length ? "：" + pa.errs.concat(pb.errs).join("; ") : ""));
  const warns = pa.logs.concat(pb.logs).filter((l) => /^(signal|offer)/.test(l)); console.log("    控制台 signal/offer 警告：", warns.length ? warns.slice(0, 5) : "无");
} catch (e) { failN++; console.log("  ✗ 异常：", e && e.stack || e); }
finally {
  if (n3) await n3.close().catch(() => {});
  if (br) await br.close().catch(() => {});
  console.log("清理");
  let r = await adm.req(`/api/admin/rooms/video/${room}`, "DELETE"); ok(r.status === 200, "删除测试房间");
  r = await adm.req("/api/admin/users?q=" + sfx);
  for (const u of r.data.rows || []) { const d = await adm.req(`/api/admin/users/${u.id}`, "DELETE"); ok(d.status === 200, "删除测试用户 " + u.username); }
  r = await adm.req("/api/admin/users?q=" + sfx); ok(r.data.rows && r.data.rows.length === 0, "测试用户已清除");
  r = await adm.req("/api/admin/rooms?q=" + sfx); ok(r.data.rows && r.data.rows.length === 0, "测试房间已清除");
}
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
