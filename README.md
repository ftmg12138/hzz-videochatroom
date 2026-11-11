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

## 界面主题（皮肤）

四套完整主题，不只是换颜色，布局、背景图案和插画都不同：

| 主题 | 布局 | 背景 / 装饰 | 插画 |
|---|---|---|---|
| `forest` 森林小屋（默认） | 左侧栏 + 帮助卡片 | 叶片角落装饰、点阵 | 龟背竹 hero、盆栽吉祥物 |
| `night` 星夜梦境 | 顶部导航、居中 hero、玻璃卡片 | 星座图案（SVG） | 极光 hero、猫头鹰宇航员 |
| `cream` 奶油萌宠 | 悬浮图标轨道、泡泡卡片、扇贝边 hero | 爪印 / 云朵图案 | 奶蛙和小伙伴 |
| `tavern` 西幻酒馆 | 木质招牌顶栏、公会告示板（钉住的羊皮纸卡片） | 羊皮纸纹理、木纹、花边边框 | 酒馆 hero、矮人店主 |

- 文件：`public/skins.css`（全部主题样式）、`public/themes/`（WebP 插画 + SVG 图案，约 1.6 MB）、`public/theme.js`（在 `<head>` 里尽早设置 `html[data-skin]`）、`common.js` 里的 `SKINS` 配置（每套主题的文案）和主题选择器。
- 主题保存在账号上（`users.theme`，迁移 v5；`POST /api/theme {theme}`），两个站点同步；未登录时用 localStorage `hzz-skin`。
- 插画都通过 CSS 变量引用（`--hero`、`--auth-art`、`--mascot`、`--cv1..3` 等），新增主题只需加一段 `html[data-skin=xxx]{…}` 和 `SKINS` 里的一项，并把名字加到 `directory.js` 的 `setTheme` 白名单。
- 手机端：侧栏变成抽屉 + 底部标签栏；hero 改成「上图下文」。
- `skins.css`、`common.js`、`theme.js`、`themes/` 两个站点内容相同，修改后复制到 videochatroom。

本地预览（不碰线上数据）：在两个项目里各放一个 `.dev.vars`（已被 git 忽略），设置 `COOKIE_DOMAIN=""`，并把 `ALLOWED_ORIGINS` 设成 wrangler dev 改写后的来源（`http://chatroom.xyzhzz.com` / `https://videochatroom.xyzhzz.com` 等），然后
`npx wrangler dev -c wrangler.toml -c ../videochatroom/wrangler.toml --port 8799 --persist-to /tmp/state`（视频站则反过来，加 `--upstream-protocol https`）。两个独立的 wrangler dev 会话之间不支持 DO RPC，所以要用多配置的单一会话。

## NAT 穿透与连接健壮性
- 默认：STUN（stun.cloudflare.com、stun.miwifi.com、stun.l.google.com）
- TURN（可选，全部用 Worker secret 配置，换服务商不用改代码；可同时配置多个，结果合并）：
  1. Cloudflare Realtime TURN：`TURN_KEY_ID` + `TURN_KEY_API_TOKEN` → 服务端签发 6 小时凭据（需绑卡）
  2. Metered（免费版 / Open Relay）：`METERED_API_KEY` + `METERED_APP`（`xxx.metered.live` 里的 `xxx`），可选 `METERED_REGION` → 服务端拉取 iceServers（缓存 10 分钟）
  3. 自建 coturn（`use-auth-secret`）：`TURN_URLS` + `TURN_SECRET` → Worker 用 HMAC-SHA1 签发 6 小时限时凭据，密钥不下发浏览器
  4. 固定账号（如 ExpressTURN 免费版）：`TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL`（TURN 协议要求浏览器持有该账号）
  `TURN_URLS` 用逗号或空格分隔，例如 `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp`。
  ```bash
  printf '%s' "<值>" | npx wrangler secret put METERED_API_KEY   # 其他同理，不要把值写进命令历史或仓库
  ```
- 前端（public/app.js）：完美协商（polite/impolite 按 peerId 比较，双方同时 offer 不会卡住）；
  12 秒未连上或断开超过 5 秒 → 发起方 ICE restart，最多 3 次，之后显示「连接失败，点击重试」，点击后两端重建连接；
  视频上行 2 人约 500 kbps、3–4 人约 300 kbps（3 人以上采集降到 480×360@20）；连上后画面右下角小字显示「直连 / 中继」。
- 测试：`MAINT_TOKEN_FILE=... [LOCAL=1] node test/restart.mjs`（LOCAL=1 用本地前端文件替换线上文件，部署前验证）

## 部署 / 测试 / 备份
```bash
scripts/deploy.sh                       # 需要 CLOUDFLARE_API_TOKEN
MAINT_TOKEN_FILE=/workspace/.secrets/chatroom-maint node test/e2e.mjs   # 维护令牌方式（见 chatroom README），不动管理员密码
scripts/push.sh "提交说明"               # 需要 CHATROOM_GITHUB_TOKEN → ftmg12138/hzz-videochatroom
```
