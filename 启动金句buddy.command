#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print '请安装 Node.js 22.16 或更高版本，再打开此文件。'
  read -r '?按回车关闭。'
  exit 1
fi
if [[ ! -d node_modules/ws || ! -d node_modules/sharp || ! -d node_modules/jsqr || ! -d node_modules/fontkit ]]; then
  npm ci --omit=dev --no-audit --no-fund
fi
event_url="$(node --input-type=module -e 'import {config} from "./server/config.js"; console.log((config.tlsKey?"https":"http")+"://localhost:"+config.port+"/e/"+config.id)')"
ready() {
  curl --noproxy '*' -fsS --max-time 1 "$event_url/api/stage" 2>/dev/null | /usr/bin/grep -q '"screen"'
}
if ready; then
  open "$event_url/control"
  exit 0
fi
node server/main.js &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for attempt in {1..60}; do
  if ready; then open "$event_url/control"; break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then wait "$server_pid"; exit 1; fi
  sleep 0.2
done
print '活动期间请保持此窗口开启。按 Control-C 停止后台。'
wait "$server_pid"
