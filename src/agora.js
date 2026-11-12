// 声网 Agora RTC Token（AccessToken2 / "007" 格式）—— 纯 WebCrypto + CompressionStream 实现，与官方 npm `agora-token` 的 RtcTokenBuilder2 等价。
// 结构：
//   signing      = HMAC256(key=u32le(salt), HMAC256(key=u32le(issueTs), appCertificate))
//   signing_info = str(appId) u32(issueTs) u32(expire) u32(salt) u16(nServices) + ServiceRtc
//   ServiceRtc   = u16(1) u16(nPriv) {u16 key, u32 expire}... str(channel) str(uid 或 "")
//   token        = "007" + base64(zlib_deflate( str(HMAC256(signing, signing_info)) + signing_info ))
// 其中 str(x) = u16le(字节长度) + 字节；expire / 权限过期都是「相对签发时刻的秒数」。
const te = new TextEncoder();
const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const bytes = (x) => (typeof x === "string" ? te.encode(x) : x);
const str = (x) => { const b = bytes(x); return cat(u16(b.length), b); };
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", bytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes(msg)));
}
async function deflate(data) {
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate")); // "deflate" = zlib 格式（RFC 1950），与 zlib.deflateSync 相同
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function b64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }

export const RTC_PRIV = { join: 1, publishAudio: 2, publishVideo: 3, publishData: 4 };
const HEX32 = /^[0-9a-f]{32}$/i;

// 发布者角色 Token。opts.issueTs / opts.salt 仅供测试固定随机量。
export async function buildRtcToken(appId, appCertificate, channel, uid, expireSecs, opts = {}) {
  if (!HEX32.test(appId || "") || !HEX32.test(appCertificate || "")) throw new Error("Agora App ID / 证书未配置或格式错误");
  const issueTs = opts.issueTs ?? Math.floor(Date.now() / 1000);
  const salt = opts.salt ?? (crypto.getRandomValues(new Uint32Array(1))[0] % 99999999) + 1;
  const privExpire = opts.privilegeExpire ?? expireSecs;
  const privs = [RTC_PRIV.join, RTC_PRIV.publishAudio, RTC_PRIV.publishVideo, RTC_PRIV.publishData];
  const service = cat(u16(1), u16(privs.length), ...privs.flatMap((k) => [u16(k), u32(privExpire)]), str(channel), str(uid ? String(uid) : ""));
  const info = cat(str(appId), u32(issueTs), u32(expireSecs), u32(salt), u16(1), service);
  const signing = await hmac(u32(salt), await hmac(u32(issueTs), appCertificate)); // hmac(key, msg)
  const sig = await hmac(signing, info);
  return "007" + b64(await deflate(cat(str(sig), info)));
}

// 频道名：只用 [0-9a-z_]，与房间号一一对应但不暴露原文（房间号可能含中文等声网不支持的字符）
export async function channelFor(roomNumber) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode("hzz-video:" + String(roomNumber).toLowerCase())));
  return "v_" + [...h.subarray(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
