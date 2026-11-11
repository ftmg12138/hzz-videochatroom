// 用纯 JS WebRTC 实现（werift）模拟两个成员，通过线上信令 WebSocket 完成 offer/answer/ICE 并达到 connected。
// （本测试机的 Chrome 受托管策略限制不能产生 ICE 候选，因此用它验证信令链路的完整连通。）
import WebSocket from "ws";
import { RTCPeerConnection } from "werift";

export function nodePeer(base, cookie, room) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/api/rooms/${encodeURIComponent(room)}/ws`, { headers: { Cookie: cookie, Origin: base } });
  const pcs = new Map();
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  function make(id) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = ({ candidate }) => candidate && send({ type: "signal", to: id, data: { candidate: candidate.toJSON ? candidate.toJSON() : candidate } });
    pcs.set(id, { pc, queue: [] });
    return pcs.get(id);
  }
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "welcome") {
      for (const p of m.peers) {
        const { pc } = make(p.peerId);
        pc.addTransceiver("audio", { direction: "sendrecv" });
        pc.addTransceiver("video", { direction: "sendrecv" });
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: "signal", to: p.peerId, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
      }
    } else if (m.type === "signal") {
      const e = pcs.get(m.from) || make(m.from);
      const d = m.data;
      if (d.sdp) {
        await e.pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === "offer") {
          await e.pc.setLocalDescription(await e.pc.createAnswer());
          send({ type: "signal", to: m.from, data: { sdp: { type: e.pc.localDescription.type, sdp: e.pc.localDescription.sdp } } });
        }
        for (const c of e.queue.splice(0)) await e.pc.addIceCandidate(c).catch(() => {});
      } else if (d.candidate) {
        if (e.pc.remoteDescription) await e.pc.addIceCandidate(d.candidate).catch(() => {}); else e.queue.push(d.candidate);
      }
    }
  });
  return {
    ws, pcs,
    opened: new Promise((r) => { ws.once("open", () => r(true)); ws.once("unexpected-response", (_q, res) => r(res.statusCode)); }),
    states: () => [...pcs.values()].map((e) => e.pc.connectionState),
    close: async () => { for (const e of pcs.values()) await e.pc.close().catch(() => {}); ws.close(); },
  };
}
