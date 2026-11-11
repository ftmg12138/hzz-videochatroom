# HZZ 视频聊天室 · videochatroom.xyzhzz.com

WebRTC mesh 视频房间（2–4 人），纯 Cloudflare：Worker + Durable Object。账号、会话、房间登记和访问日志**复用 chatroom**。

## 结构
- `src/worker.js` — 入口：登录/注册/改密（调用 chatroom 的 `Directory` DO）、视频房间创建/加入、`/api/ice`、信令 WebSocket 转发；页面访问记为 `video_visit`
- `src/videoroom.js` — `VideoRoom` DO（每房间一个）：信令转发（offer/answer/ICE，发送者身份由服务器填写）、成员进出、媒体状态、房间文字聊天（SQLite）、满员（`MAX_PEERS`=4）判断；管理 RPC 与 chatroom 的 `ChatRoom` 同名
- `public/avatars/` — 预设头像（由 `../chatroom/scripts/sync-avatars.sh` 同步）
- `public/` — 前端（进房前的摄像头权限说明页、视频网格、静音/摄像头/翻转/共享屏幕/聊天/离开）
- `test/e2e.mjs` — 线上端到端测试（API + 两个无头 Chrome + werift 纯 JS WebRTC 客户端 + 后台检查）

## 与 chatroom 的关系
- wrangler 绑定：`DIRECTORY` → `Directory`（script_name = "chatroom"）
- chatroom 反向绑定：`VROOMS` → `VideoRoom`（script_name = "videochatroom"），后台据此查看/清空视频房间聊天、踢人、删除视频房间
- 同一 Cookie `hzz_sid`（Domain=xyzhzz.com），两站登录互通；视频和文字房间号**各自独立**（同号可并存，按 kind + number 区分）
- 公开 / 私密房间、加入申请（房主在视频房间顶部 📨 处理）、头像（视频格子、聊天、大厅）、注册口令与 chatroom 一致，详见 chatroom README
- 日志事件：`video_request`、`video_request_approve`、`video_request_reject`、`video_visit`、`video_room_create`、`video_join`、`video_join_fail`、`video_join_limited`、`video_connect`、`video_leave`（均带 IP/国家/UA），后台日志可按「仅视频」筛选
- 首次部署顺序：chatroom（不带 VROOMS）→ videochatroom → chatroom（带 VROOMS）。之后各自独立部署即可。

## NAT 穿透
- 默认：STUN（stun.cloudflare.com、stun.l.google.com）
- TURN（可选）：设置 Worker secret `TURN_KEY_ID`、`TURN_KEY_API_TOKEN`（Cloudflare Realtime → TURN Server 里创建的密钥），
  `/api/ice` 会在服务端调用 `rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers` 签发 6 小时有效的凭据，前端无需改动。
  ```bash
  printf '%s' "<Key ID>" | npx wrangler secret put TURN_KEY_ID
  printf '%s' "<API Token>" | npx wrangler secret put TURN_KEY_API_TOKEN
  ```

## 部署 / 测试 / 备份
```bash
scripts/deploy.sh                       # 需要 CLOUDFLARE_API_TOKEN
MAINT_TOKEN_FILE=/workspace/.secrets/chatroom-maint node test/e2e.mjs   # 维护令牌方式（见 chatroom README），不动管理员密码
scripts/push.sh "提交说明"               # 需要 CHATROOM_GITHUB_TOKEN → ftmg12138/hzz-videochatroom
```
