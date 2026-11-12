# HZZ 视频聊天室 · videochatroom.xyzhzz.com

视频房间（2–4 人）：页面、账号、房间、信令和聊天在 Cloudflare（Worker + Durable Object），**音视频走声网 Agora RTC**（国内节点，不再浏览器点对点直连）。账号、会话、房间登记和访问日志**复用 chatroom**。

## 结构
- `src/worker.js` — 入口：登录/注册/改密（调用 chatroom 的 `Directory` DO）、视频房间创建/加入、声网 Token 接口、房间 WebSocket；页面访问记为 `video_visit`
- `src/videoroom.js` — `VideoRoom` DO（每房间一个）：成员进出（给每个连接分配声网 uid）、签发声网 Token、媒体状态、房间文字聊天（SQLite）、满员（`MAX_PEERS`=4）判断；管理 RPC 与 chatroom 的 `ChatRoom` 同名
- `src/agora.js` — 声网 AccessToken2（007）生成：WebCrypto HMAC-SHA256 + CompressionStream（zlib），与官方 `agora-token` 逐字节一致
- `public/vendor/AgoraRTC_N-4.24.9.js` — 声网 Web SDK（npm `agora-rtc-sdk-ng@4.24.9`，MIT），放在本站，进房时才加载，不依赖第三方 CDN
- `public/avatars/` — 预设头像（由 `../chatroom/scripts/sync-avatars.sh` 同步）
- `public/` — 前端（进房前的摄像头权限说明页、视频网格、静音/摄像头/翻转/共享屏幕/聊天/离开）
- `test/e2e.mjs` — 线上端到端测试（API、Token 鉴权与解码、无头 Chrome 假摄像头真实加入声网频道收发音视频、后台检查）
- `test/agora-token.mjs` — 本地：Token 与官方 `agora-token` 逐字节比较 + 官方签名校验

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

## 音视频（声网 Agora RTC）
- 之前的浏览器点对点（mesh）在国内运营商 NAT 下经常连不上，且没有 TURN 中继，已改为声网。
- 声网控制台项目用「安全模式」（App ID + Token）。Worker secret：`AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`（证书只在服务端用来签名，App ID 会下发浏览器，这是正常的）：
  ```bash
  printf %s "$AGORA_APP_ID" | npx wrangler secret put AGORA_APP_ID
  printf %s "$AGORA_APP_CERTIFICATE" | npx wrangler secret put AGORA_APP_CERTIFICATE
  ```
- 流程：凭房间密码加入 → 连上房间 WebSocket（满员、封禁、私密房等检查不变）→ `welcome` 里带 `{appId, channel, uid, token}` → 浏览器加入声网频道并发布麦克风/摄像头。
  - 频道名：`v_` + sha256(房间号) 前 24 位十六进制（房间号可能含声网不支持的字符）。
  - uid：每个 WebSocket 连接由 DO 随机分配（同一账号多设备不冲突），成员列表 / `peer-join` 里带 `rtcUid`，前端据此把远端画面对应到用户名和头像。
  - Token：发布者权限，有效期 2 小时；快过期时 SDK 触发 `token-privilege-will-expire`，前端经 WebSocket 发 `rtc-renew` 续期（只给仍在房间里的连接续签）。
  - `POST /api/rooms/:number/rtc-token {peerId?}`：同样的 Token，HTTP 方式（需登录、已凭密码加入、且当前在房间里，否则 401/403/409）。
- 前端：本地仍用 getUserMedia 采集（预览、翻转、屏幕共享不变），包装成声网自定义轨道发布；静音 / 关摄像头 = 取消发布对应轨道。
  上行 2 人约 500 kbps、3–4 人约 300 kbps（采集降到 480×360@20），屏幕共享 1 Mbps / 600 kbps。画面右下角显示对方到声网的网络质量。
- CSP：`connect-src` 放开 `https: wss:`（声网网关/边缘节点地址动态分配），`worker-src blob:`，`style-src` 加 `'unsafe-inline'`（SDK 给自己的隐藏元素写内联样式）；`script-src` 仍只允许本站。
- 已知限制：被踢 / 封禁的人前端会立刻退出声网频道，但已签发的 Token 在过期前（≤2 小时）理论上仍可被改过的客户端使用；需要更严可以缩短有效期或接声网 RESTful 踢人接口。
- `/api/ice`（STUN/TURN 配置）保留但前端已不再使用。

## 部署 / 测试 / 备份
```bash
scripts/deploy.sh                       # 需要 CLOUDFLARE_API_TOKEN
MAINT_TOKEN_FILE=/workspace/.secrets/chatroom-maint node test/e2e.mjs   # 维护令牌方式（见 chatroom README），不动管理员密码；有 AGORA_APP_CERTIFICATE 环境变量时额外校验 Token 签名
node test/agora-token.mjs                # 本地 Token 算法对照官方 agora-token
scripts/push.sh "提交说明"               # 需要 CHATROOM_GITHUB_TOKEN → ftmg12138/hzz-videochatroom
```
