(() => {
  let me = null, mode = "login", rmode = "join";
  const views = ["v-auth", "v-chpw", "v-lobby", "v-perm", "v-room"];
  const show = (id) => views.forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));

  // ===== 路由 =====
  async function boot() {
    if (!window.isSecureContext || !navigator.mediaDevices) { document.body.innerHTML = '<div class="wrap"><div class="card">请使用 HTTPS 和较新的浏览器（Chrome / Edge / Safari / 微信内置浏览器可能受限）访问。</div></div>'; return; }
    try { me = (await api("/api/me")).user; } catch { me = null; }
    route();
  }
  function route() {
    if (me) avSet(me.username, me.avatar);
    window.__me = me;
    if (!me) { leaveRoom(true); show("v-auth"); return; }
    syncSkin(me);
    if (me.mustChange) { leaveRoom(true); $("#c-cancel").classList.add("hidden"); show("v-chpw"); return; }
    const m = location.hash.match(/^#\/room\/(.+)$/);
    if (m) {
      const n = decodeURIComponent(m[1]);
      if (R.room === n && R.ws) return show("v-room");
      leaveRoom(true); R.pending = n; preparePerm(); show("v-perm");
    } else { leaveRoom(true); show("v-lobby"); lobby(); }
  }
  window.addEventListener("hashchange", route);

  // ===== 登录注册 / 改密 =====
  $$("[data-tab]").forEach((b) => b.onclick = () => {
    mode = b.dataset.tab;
    $$("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
    $("#reg-extra").classList.toggle("hidden", mode !== "register");
    $("#a-submit").textContent = mode === "login" ? "登录" : "注册并登录";
    setMsg($("#a-msg"), "");
    if (mode === "register") api("/api/reg-config").then((d) => $("#code-wrap").classList.toggle("hidden", !d.codeRequired)).catch(() => {});
  });
  $("#f-auth").onsubmit = (e) => {
    e.preventDefault();
    const username = $("#a-user").value.trim(), password = $("#a-pass").value;
    if (mode === "register" && password !== $("#a-pass2").value) return setMsg($("#a-msg"), "两次输入的密码不一致");
    busy($("#a-submit"), async () => {
      const code = $("#code-wrap").classList.contains("hidden") ? undefined : $("#a-code").value.trim();
      try {
        me = (await api("/api/" + mode, { method: "POST", body: { username, password, code } })).user; $("#a-pass").value = $("#a-pass2").value = "";
        const isNew = mode === "register"; route();
        if (isNew && me && !me.mustChange) { const u = await openAvatarPicker(me, { welcome: true }); if (u) { me = u; route(); } }
      }
      catch (er) { setMsg($("#a-msg"), er.message); }
    });
  };
  $("#f-chpw").onsubmit = async (e) => {
    e.preventDefault();
    if ($("#c-new").value !== $("#c-new2").value) return setMsg($("#c-msg"), "两次输入的新密码不一致");
    try {
      me = (await api("/api/password", { method: "POST", body: { oldPassword: $("#c-old").value, newPassword: $("#c-new").value } })).user;
      ["#c-old", "#c-new", "#c-new2"].forEach((s) => ($(s).value = "")); setMsg($("#c-msg"), ""); toast("密码已修改"); route();
    } catch (er) { setMsg($("#c-msg"), er.message); }
  };
  $("#l-pw").onclick = () => { $("#c-tip").textContent = "修改后其他设备上的登录会失效（文字聊天室同步生效）。"; $("#c-cancel").classList.remove("hidden"); show("v-chpw"); };
  $("#c-cancel").onclick = () => route();
  $("#l-logout").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); me = null; location.hash = ""; route(); };

  // ===== 大厅 =====
  let pubTimer = null;
  let myList = [], pubList = [];
  const V = { kind: "video" };
  function lobbyStats() {
    $("#st-online").textContent = pubList.reduce((a, r) => a + (r.online || 0), 0);
    $("#st-my").textContent = myList.length; $("#st-pub").textContent = pubList.length;
    $("#st-own").textContent = myList.filter((r) => r.creator_name === me.username).length;
    $("#l-feed").innerHTML = Lobby.feed(myList, pubList);
  }
  function renderMy() {
    const box = $("#l-rooms");
    box.innerHTML = myList.length ? Lobby.cards(myList, "my", V) : `<div class="empty">还没有视频房间。创建一个，或用房间号和密码加入 ✨</div>`;
    $$("[data-leave]", box).forEach((b) => b.onclick = async () => {
      if (!confirm("从列表移除该房间？之后再进需要重新输入房间密码或重新申请。")) return;
      await api("/api/rooms/leave", { method: "POST", body: { number: b.dataset.leave } }); lobby();
    });
  }
  async function lobby() {
    $("#l-name").textContent = me.username;
    $("#l-av").innerHTML = `<button class="av-me" id="l-avbtn" type="button" title="设置头像">${avatar(me.username)}</button>`;
    $("#l-avbtn").onclick = pickAvatar;
    $("#l-admin")?.classList.toggle("hidden", !me.isAdmin);
    try {
      const { rooms } = await api("/api/rooms");
      const m = new Map(pubList.map((r) => [r.number, r]));
      myList = rooms.map((r) => (m.has(r.number) ? { ...r, online: m.get(r.number).online } : r));
      $("#l-rooms-n").textContent = rooms.length;
      renderMy(); Lobby.search(); lobbyStats();
    } catch (er) { if (er.status === 401) { me = null; route(); return; } }
    publicRooms();
  }
  async function pickAvatar() { const u = await openAvatarPicker(me); if (u) { me = u; lobby(); } }
  $("#l-avatar").onclick = pickAvatar;
  async function publicRooms() {
    clearTimeout(pubTimer);
    if ($("#v-lobby").classList.contains("hidden")) return;
    try {
      const { rooms } = await api("/api/rooms/public");
      pubList = rooms;
      $("#l-pub-n").textContent = rooms.length;
      $("#l-pub").innerHTML = rooms.length ? Lobby.cards(rooms, "pub", V) : `<div class="empty">还没有公开视频房间。创建房间时选「公开」，就会出现在这里。</div>`;
      $$("[data-req]").forEach((b) => b.onclick = () => busy(b, async () => {
        try { const d = await api("/api/rooms/request", { method: "POST", body: { number: b.dataset.req } }); if (d.member) location.hash = "#/room/" + encodeURIComponent(b.dataset.req); else { toast("已发送申请，房主同意后即可进入"); publicRooms(); } }
        catch (er) { toast(er.message); }
      }));
      const m = new Map(rooms.map((r) => [r.number, r]));
      if (myList.some((r) => m.has(r.number) && r.online !== m.get(r.number).online)) { myList = myList.map((r) => (m.has(r.number) ? { ...r, online: m.get(r.number).online } : r)); renderMy(); }
      Lobby.search(); lobbyStats();
      if (rooms.some((r) => r.pending)) pubTimer = setTimeout(() => { if (!$("#v-lobby").classList.contains("hidden")) lobby(); }, 5000);
    } catch {}
  }
  $$("[data-rtab]").forEach((b) => b.onclick = () => {
    rmode = b.dataset.rtab;
    $$("[data-rtab]").forEach((x) => x.classList.toggle("on", x === b));
    $("#r-create-extra").classList.toggle("hidden", rmode !== "create");
    $("#r-vis-wrap").classList.toggle("hidden", rmode !== "create");
    $("#r-submit").textContent = rmode === "join" ? "加入" : "创建并进入";
    visHint(); setMsg($("#r-msg"), "");
  });
  const vis = () => (document.querySelector('input[name="r-vis"]:checked') || {}).value || "private";
  function visHint() {
    const pub = rmode === "create" && vis() === "public";
    $("#r-pass-label").textContent = pub ? "房间密码（可选）" : "房间密码";
    $("#r-pass").placeholder = pub ? "留空则只能申请加入；设置后也可凭密码直接进" : "4–64 位";
  }
  $$('input[name="r-vis"]').forEach((x) => x.onchange = visHint);
  $("#f-room").onsubmit = (e) => {
    e.preventDefault();
    const number = $("#r-num").value.trim(), password = $("#r-pass").value, name = $("#r-name").value.trim();
    busy($("#r-submit"), async () => {
      try {
        const { room } = await api(rmode === "join" ? "/api/rooms/join" : "/api/rooms", { method: "POST", body: { number, password, name, visibility: vis() } });
        $("#r-pass").value = ""; setMsg($("#r-msg"), "");
        location.hash = "#/room/" + encodeURIComponent(room.number);
      } catch (er) { setMsg($("#r-msg"), er.message); }
    });
  };

  // ===== 房主：处理加入申请 =====
  let isOwner = false;
  async function loadRequests() {
    if (!isOwner || !R.room) return;
    try {
      const { rows } = await api("/api/rooms/requests?number=" + encodeURIComponent(R.room));
      const n = $("#rq-n"); n.textContent = rows.length; n.classList.toggle("hidden", !rows.length);
      $("#rq-list").innerHTML = rows.length ? rows.map((r) => `<li><div class="row">${avatar(r.username, true)}<div><b>${esc(r.username)}</b><div class="sub">${esc(timeShort(r.created_at))} 申请</div></div></div>
        <div class="row nogrow"><button class="btn ok sm" data-ok="${r.id}">同意</button><button class="btn ghost sm" data-no="${r.id}">拒绝</button></div></li>`).join("") : `<li class="empty">暂时没有新的申请</li>`;
    } catch {}
  }
  $("#rq-btn").onclick = () => { $("#rq-panel").classList.toggle("hidden"); loadRequests(); };
  $("#rq-close").onclick = () => $("#rq-panel").classList.add("hidden");
  $("#rq-list").onclick = async (e) => {
    const b = e.target.closest("[data-ok],[data-no]"); if (!b) return;
    try { const d = await api("/api/rooms/requests/decide", { method: "POST", body: { id: Number(b.dataset.ok || b.dataset.no), approve: !!b.dataset.ok } }); toast(d.status === "approved" ? `已同意 ${d.username}` : `已拒绝 ${d.username}`); }
    catch (er) { toast(er.message); }
    loadRequests();
  };
  $("#vr-back").onclick = () => { location.hash = ""; };

  // ===== 设备权限 =====
  const R = { room: null, pending: null, ws: null, myId: null, peers: new Map(), local: null, mic: null, cam: null, screen: null,
    micOn: true, camOn: true, ice: null, wantClose: false, retry: 0, pingT: null, unread: 0, facing: "user" };
  window.__vc = R; // 便于调试 / 自动化测试读取连接状态

  function preparePerm() {
    setMsg($("#p-msg"), "");
    $("#p-preview").classList.add("hidden");
  }
  async function getMedia(video, audio) {
    return navigator.mediaDevices.getUserMedia({
      video: video ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 }, facingMode: R.facing } : false,
      audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
  }
  function permError(er) {
    const n = er && er.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "你拒绝了摄像头/麦克风权限。可点击地址栏左侧的🔒图标重新允许，或选择「仅观看」。";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "没有找到摄像头或麦克风设备。";
    if (n === "NotReadableError") return "设备被其他程序占用（例如其他会议软件），请关闭后重试。";
    return "无法打开设备：" + (er && er.message || n || "未知错误");
  }
  async function startWith(video, audio, btn) {
    setMsg($("#p-msg"), "");
    let stream = null;
    if (video || audio) {
      try { stream = await getMedia(video, audio); }
      catch (er) { setMsg($("#p-msg"), permError(er)); return; }
    }
    R.local = stream;
    R.mic = stream?.getAudioTracks()[0] || null;
    R.cam = stream?.getVideoTracks()[0] || null;
    R.micOn = !!R.mic; R.camOn = !!R.cam;
    enterRoom(R.pending);
  }
  $("#p-allow").onclick = (e) => busy(e.target, () => startWith(true, true));
  $("#p-audio").onclick = (e) => busy(e.target, () => startWith(false, true));
  $("#p-none").onclick = () => startWith(false, false);
  $("#p-back").onclick = () => { location.hash = ""; };

  // ===== 房间 =====
  async function enterRoom(number) {
    R.room = number; R.wantClose = false; R.retry = 0; R.unread = 0;
    $("#vr-grid").innerHTML = ""; $("#vr-msgs").innerHTML = "";
    $("#vr-title").textContent = "视频房间 " + number;
    show("v-room");
    addTile("local", me.username + "（我）", true, me.username);
    isOwner = false; $("#rq-btn").classList.add("hidden"); $("#rq-panel").classList.add("hidden");
    updateLocalTile(); updateButtons();
    try { R.ice = (await api("/api/ice")).iceServers; } catch { R.ice = [{ urls: "stun:stun.cloudflare.com:3478" }]; }
    connect();
  }
  function status(t) { $("#vr-status").textContent = t; }
  function connect() {
    const room = R.room;
    status("连接中…");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${encodeURIComponent(room)}/ws`);
    R.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; R.retry = 0; clearInterval(R.pingT); R.pingT = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25000); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onSignal(m); };
    ws.onclose = async () => {
      if (R.ws !== ws) return;
      clearInterval(R.pingT);
      closeAllPeers();
      if (R.wantClose || R.room !== room) return;
      if (!opened) {
        try { me = (await api("/api/me")).user; } catch { me = null; return route(); }
        if (R.retry >= 1) { status("无法进入：请先在大厅用房间号和密码加入"); toast("无法进入该房间，请先输入房间密码加入"); setTimeout(() => (location.hash = ""), 1500); return; }
      }
      R.retry++;
      const wait = Math.min(1000 * 2 ** R.retry, 15000);
      status(`连接断开，${Math.round(wait / 1000)} 秒后重连…`);
      setTimeout(() => { if (R.room === room && !R.wantClose) connect(); }, wait);
    };
  }
  function wsSend(o) { if (R.ws && R.ws.readyState === 1) R.ws.send(JSON.stringify(o)); }
  function sendState() { wsSend({ type: "state", audio: !!(R.mic && R.micOn), video: !!((R.cam && R.camOn) || R.screen), screen: !!R.screen }); }

  async function onSignal(m) {
    switch (m.type) {
      case "welcome":
        R.myId = m.you;
        $("#vr-title").textContent = (m.visibility === "public" ? "🌿 " : "🎥 ") + (m.name || "视频房间 " + m.room);
        isOwner = !!m.isOwner; $("#rq-btn").classList.toggle("hidden", !isOwner); if (isOwner) loadRequests();
        m.history.forEach(addChat);
        sendState();
        for (const p of m.peers) { const peer = createPeer(p.peerId, p.username, true); applyState(peer, p.state); }
        updateCount();
        break;
      case "full": toast(m.error, 4000); R.wantClose = true; setTimeout(() => (location.hash = ""), 1200); break;
      case "peer-join": createPeer(m.peerId, m.username, false); addSys(`${m.username} 加入了房间`); updateCount(); break;
      case "peer-leave": { const p = R.peers.get(m.peerId); if (p) { removePeer(m.peerId); addSys(`${m.username} 离开了房间`); } updateCount(); break; }
      case "peer-state": { const p = R.peers.get(m.peerId); if (p) applyState(p, m.state); break; }
      case "signal": await handleSignal(m.from, m.username, m.data); break;
      case "chat": addChat(m.msg); if ($("#vr-chat").classList.contains("hidden")) { R.unread++; updateButtons(); } break;
      case "chat-deleted": { const el = document.querySelector(`#vr-msgs [data-id="${m.id}"]`); if (el) el.remove(); break; }
      case "chat-cleared": $("#vr-msgs").innerHTML = ""; addSys("管理员清空了聊天记录"); break;
      case "kicked": R.wantClose = true; alert(m.reason); location.hash = ""; break;
      case "error": toast(m.error); break;
      case "join-request": toast(`${m.username} 申请加入房间`); loadRequests(); break;
    }
  }

  // ----- WebRTC mesh -----
  function trackFor(kind) { return kind === "audio" ? R.mic : (R.screen || R.cam); }
  function createPeer(peerId, username, initiator) {
    if (R.peers.has(peerId)) return R.peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: R.ice || [] });
    const peer = { id: peerId, username, pc, initiator, queue: [], stream: new MediaStream(), restarted: 0, state: { audio: true, video: true } };
    R.peers.set(peerId, peer);
    peer.tile = addTile(peerId, username, false);
    peer.tile.querySelector("video").srcObject = peer.stream;
    pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: "signal", to: peerId, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      const v = peer.tile.querySelector("video"); v.srcObject = peer.stream; v.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      const badge = peer.tile.querySelector(".conn");
      badge.textContent = { new: "连接中", connecting: "连接中", connected: "", disconnected: "网络不稳", failed: "连接失败", closed: "" }[s] || s;
      badge.classList.toggle("hidden", s === "connected" || s === "closed");
      if (s === "failed" && peer.initiator && peer.restarted < 2) { peer.restarted++; makeOffer(peer, true); }
    };
    if (initiator) {
      pc.addTransceiver("audio", { direction: "sendrecv" }).sender.replaceTrack(trackFor("audio"));
      pc.addTransceiver("video", { direction: "sendrecv" }).sender.replaceTrack(trackFor("video"));
      makeOffer(peer, false);
    }
    return peer;
  }
  async function makeOffer(peer, iceRestart) {
    try {
      const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await peer.pc.setLocalDescription(offer);
      wsSend({ type: "signal", to: peer.id, data: { sdp: peer.pc.localDescription } });
    } catch (e) { console.warn("offer", e); }
  }
  async function handleSignal(from, username, data) {
    let peer = R.peers.get(from) || createPeer(from, username, false);
    const pc = peer.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === "offer") {
          for (const t of pc.getTransceivers()) {
            const kind = t.receiver.track.kind;
            t.direction = "sendrecv";
            await t.sender.replaceTrack(trackFor(kind));
          }
          await pc.setLocalDescription(await pc.createAnswer());
          wsSend({ type: "signal", to: from, data: { sdp: pc.localDescription } });
        }
        for (const c of peer.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.queue.push(data.candidate);
      }
    } catch (e) { console.warn("signal", e); }
  }
  function replaceVideoTrack() {
    for (const p of R.peers.values()) for (const t of p.pc.getTransceivers()) {
      if (t.receiver.track.kind === "video" && t.currentDirection !== "stopped") t.sender.replaceTrack(trackFor("video")).catch(() => {});
    }
  }
  function removePeer(id) {
    const p = R.peers.get(id); if (!p) return;
    try { p.pc.close(); } catch {}
    p.tile.remove(); R.peers.delete(id); layout();
  }
  function closeAllPeers() { for (const id of [...R.peers.keys()]) removePeer(id); updateCount(); }
  function applyState(peer, s) {
    peer.state = s || {};
    const off = peer.tile.querySelector(".off");
    off.classList.toggle("hidden", !!peer.state.video);
    peer.tile.classList.toggle("screen", !!peer.state.screen);
    peer.tile.querySelector(".mic").textContent = peer.state.audio ? "" : "🔇";
  }

  // ----- 画面 -----
  function addTile(id, name, local, uname = name) {
    const d = document.createElement("div");
    d.className = "tile" + (local ? " local" : "");
    d.dataset.peer = id;
    d.innerHTML = `<video autoplay playsinline ${local ? "muted" : ""}></video>
      <div class="off hidden">${avatar(uname)}</div>
      <div class="conn ${local ? "hidden" : ""}">连接中</div>
      <div class="name"><b class="mic"></b><span></span></div>`;
    d.querySelector(".name span").textContent = name;
    d.querySelector(".name").insertAdjacentHTML("afterbegin", avatar(uname, true));
    $("#vr-grid").appendChild(d);
    layout();
    return d;
  }
  function layout() {
    const g = $("#vr-grid"), n = g.children.length;
    g.className = "grid n" + Math.min(n, 4);
  }
  function updateLocalTile() {
    const t = $('.tile[data-peer="local"]'); if (!t) return;
    const v = t.querySelector("video");
    const track = R.screen || R.cam;
    v.srcObject = track ? new MediaStream([track]) : null;
    t.querySelector(".off").classList.toggle("hidden", !!(R.screen || (R.cam && R.camOn)));
    t.classList.toggle("screen", !!R.screen);
    t.querySelector(".mic").textContent = R.mic && R.micOn ? "" : "🔇";
  }
  function updateCount() { status(`${R.peers.size + 1} 人在房间（最多 4 人）`); }
  function updateButtons() {
    const mic = $("#b-mic"), cam = $("#b-cam");
    mic.classList.toggle("off", !(R.mic && R.micOn)); mic.innerHTML = (R.mic && R.micOn ? "🎙️" : "🔇") + `<small>${R.mic ? (R.micOn ? "静音" : "取消静音") : "开麦"}</small>`;
    cam.classList.toggle("off", !(R.cam && R.camOn)); cam.innerHTML = "📷" + `<small>${R.cam ? (R.camOn ? "关摄像" : "开摄像") : "开摄像"}</small>`;
    $("#b-screen").classList.toggle("on", !!R.screen);
    $("#b-screen").classList.toggle("hidden", !navigator.mediaDevices.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent));
    $("#b-chat").innerHTML = `💬<small>聊天</small>${R.unread ? `<span class="badge">${R.unread}</span>` : ""}`;
  }
  navigator.mediaDevices.enumerateDevices?.().then((ds) => { if (ds.filter((d) => d.kind === "videoinput").length < 2) $("#b-flip").classList.add("hidden"); }).catch(() => $("#b-flip").classList.add("hidden"));

  // ----- 控制按钮 -----
  async function ensureTrack(kind) {
    // 进房时没开的设备，点按钮时再申请
    try {
      const s = await getMedia(kind === "video", kind === "audio");
      const t = kind === "audio" ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
      if (!R.local) R.local = new MediaStream();
      R.local.addTrack(t);
      if (kind === "audio") R.mic = t; else R.cam = t;
      for (const p of R.peers.values()) for (const tr of p.pc.getTransceivers()) {
        if (tr.receiver.track.kind === kind && !(kind === "video" && R.screen)) tr.sender.replaceTrack(t).catch(() => {});
      }
      return true;
    } catch (er) { toast(permError(er), 4000); return false; }
  }
  $("#b-mic").onclick = async () => {
    if (!R.mic) { if (!(await ensureTrack("audio"))) return; R.micOn = true; }
    else { R.micOn = !R.micOn; R.mic.enabled = R.micOn; }
    updateButtons(); updateLocalTile(); sendState();
  };
  $("#b-cam").onclick = async () => {
    if (!R.cam) { if (!(await ensureTrack("video"))) return; R.camOn = true; }
    else { R.camOn = !R.camOn; R.cam.enabled = R.camOn; }
    updateButtons(); updateLocalTile(); sendState();
  };
  $("#b-flip").onclick = async () => {
    if (!R.cam) return;
    R.facing = R.facing === "user" ? "environment" : "user";
    try {
      const s = await getMedia(true, false); const t = s.getVideoTracks()[0];
      R.cam.stop(); R.cam = t; t.enabled = R.camOn;
      if (!R.screen) replaceVideoTrack();
      updateLocalTile();
      $('.tile[data-peer="local"]').classList.toggle("local", R.facing === "user");
    } catch (er) { toast(permError(er)); }
  };
  $("#b-screen").onclick = async () => {
    if (R.screen) { stopScreen(); return; }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      R.screen = s.getVideoTracks()[0];
      R.screen.onended = stopScreen;
      replaceVideoTrack(); updateLocalTile(); updateButtons(); sendState();
    } catch (er) { if (er.name !== "NotAllowedError") toast("无法共享屏幕：" + er.message); }
  };
  function stopScreen() {
    if (!R.screen) return;
    R.screen.onended = null; R.screen.stop(); R.screen = null;
    replaceVideoTrack(); updateLocalTile(); updateButtons(); sendState();
  }
  $("#b-chat").onclick = () => { $("#vr-chat").classList.toggle("hidden"); R.unread = 0; updateButtons(); const b = $("#vr-msgs"); b.scrollTop = b.scrollHeight; };
  $("#vr-chat-close").onclick = () => $("#vr-chat").classList.add("hidden");
  $("#b-leave").onclick = () => { location.hash = ""; };

  function leaveRoom(silent) {
    R.wantClose = true; clearInterval(R.pingT);
    if (R.ws) { try { R.ws.close(); } catch {} }
    R.ws = null; closeAllPeers();
    for (const t of [R.mic, R.cam, R.screen]) if (t) t.stop();
    if (R.local) R.local.getTracks().forEach((t) => t.stop());
    R.local = R.mic = R.cam = R.screen = null; R.room = null; R.myId = null;
  }
  window.addEventListener("pagehide", () => leaveRoom(true));

  // ----- 房间聊天 -----
  function addSys(t) { const d = document.createElement("div"); d.className = "sys"; d.textContent = t; $("#vr-msgs").appendChild(d); scrollChat(); }
  function addChat(m) {
    const d = document.createElement("div");
    const mine = m.username === me.username;
    d.className = "bubble" + (mine ? " me" : ""); d.dataset.id = m.id;
    d.innerHTML = `${avatar(m.username, true)}<div><div class="meta">${mine ? "" : esc(m.username) + " · "}${esc(timeShort(m.ts))}</div><div class="txt"></div></div>`;
    d.querySelector(".txt").textContent = m.text;
    $("#vr-msgs").appendChild(d); scrollChat();
  }
  function scrollChat() { const b = $("#vr-msgs"); b.scrollTop = b.scrollHeight; }
  $("#vr-send").onsubmit = (e) => {
    e.preventDefault();
    const t = $("#vr-input").value.trim(); if (!t) return;
    wsSend({ type: "chat", text: t }); $("#vr-input").value = "";
  };

  boot();
})();
