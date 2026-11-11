#!/usr/bin/env bash
# 部署 Worker「videochatroom」→ https://videochatroom.xyzhzz.com
# 依赖：chatroom Worker 已部署（这里通过 script_name 绑定它的 Directory DO）。需要 CLOUDFLARE_API_TOKEN。
# TURN（可选）：设置 secret TURN_KEY_ID / TURN_KEY_API_TOKEN 后，/api/ice 会在服务端签发 Cloudflare Realtime TURN 凭据。
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?请先设置 CLOUDFLARE_API_TOKEN}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f57ee3b3ec6a868c05a73c1b2b54d531}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.cache}"
mkdir -p "$XDG_CACHE_HOME" node_modules/.cache/wrangler
[ -x node_modules/.bin/wrangler ] || npm install --no-audit --no-fund >/dev/null
for f in src/*.js public/*.js; do node --check "$f"; done
echo "部署 videochatroom Worker …"
node_modules/.bin/wrangler deploy 2>&1 | grep -v -i -e token -e password
echo "检查线上…"
sleep 3
curl -s -o /dev/null -w "videochatroom.xyzhzz.com -> HTTP %{http_code}\n" https://videochatroom.xyzhzz.com/ || true
curl -s -o /dev/null -w "videochatroom.xyzhzz.com/api/me -> HTTP %{http_code}（未登录应为 401）\n" https://videochatroom.xyzhzz.com/api/me || true
