// 本地校验：src/agora.js 生成的 Token 与官方 npm `agora-token`（RtcTokenBuilder2）逐字节一致（解压后比较）。
// 用法：AGORA_TOKEN_PKG=/path/to/node_modules/agora-token node test/agora-token.mjs
// 不打印任何证书或 Token 内容；未提供真实密钥时用随机测试值。
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { buildRtcToken, channelFor } from "../src/agora.js";
const require = createRequire(import.meta.url);
const pkg = process.env.AGORA_TOKEN_PKG || "agora-token";
const A2 = require(pkg + "/src/AccessToken2.js");
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(c ? "  ✓" : "  ✗", n); };
const rnd = () => crypto.randomBytes(16).toString("hex");
const raw = (t) => zlib.inflateSync(Buffer.from(t.slice(3), "base64"));
for (const [label, appId, cert] of [["随机密钥", rnd(), rnd()], ["真实密钥（环境变量）", process.env.AGORA_APP_ID, process.env.AGORA_APP_CERTIFICATE]]) {
  if (!appId || !cert) { console.log("  - 跳过", label); continue; }
  const ch = await channelFor("test-" + Math.random()), uid = 123456789, ts = Math.floor(Date.now() / 1000), salt = 4242, exp = 7200;
  const ref = new A2.AccessToken2(appId, cert, ts, exp); ref.salt = salt;
  const svc = new A2.ServiceRtc(ch, uid);
  for (const k of [1, 2, 3, 4]) svc.add_privilege(k, exp);
  ref.add_service(svc);
  const want = ref.build();
  const got = await buildRtcToken(appId, cert, ch, uid, exp, { issueTs: ts, salt });
  ok(got.startsWith("007") && raw(got).equals(raw(want)), `${label}：解压后与官方 agora-token 逐字节一致`);
  const p = new A2.AccessToken2(); const parsed = p.from_string(got);
  const rtc = p.services.find((s) => s.service_type() === 1);
  ok(parsed && String(p.appId) === appId && p.expire === exp && rtc && rtc.__channel_name.toString() === ch && rtc.__uid.toString() === String(uid), `${label}：官方解析器能解析出 appId/频道/uid/过期`);
  ok(p.verifySignature(cert) === true, `${label}：官方 verifySignature 签名校验通过`);
}
console.log(`通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
