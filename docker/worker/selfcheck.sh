#!/bin/sh
# Checks the image against docker/worker/versions.env. Runs inside the image: entrypoint.sh starts PulseAudio first.
set -eu
. /app/docker/worker/versions.env
google-chrome --version | grep -q " $CHROME_VERSION" || { echo "chrome mismatch"; exit 1; }
[ "$(node --version)" = "v$NODE_VERSION" ] || { echo "node mismatch"; exit 1; }
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "bun mismatch"; exit 1; }
[ "$(dpkg-query -W -f='${Version}' ffmpeg)" = "$FFMPEG_VERSION" ] || { echo "ffmpeg mismatch"; exit 1; }
[ "$(node -p "require('/app/node_modules/playwright/package.json').version")" = "$PLAYWRIGHT_VERSION" ] || { echo "playwright mismatch"; exit 1; }
command -v x11vnc >/dev/null || { echo "x11vnc missing"; exit 1; }
"$TM_WECHAT_PYTHON" -c "import cv2; cv2.wechat_qrcode_WeChatQRCode" || { echo "opencv wechat detector missing"; exit 1; }
for f in detect.prototxt detect.caffemodel sr.prototxt sr.caffemodel; do
  [ -s "$TM_WECHAT_MODELS_DIR/$f" ] || { echo "wechat model $f missing"; exit 1; }
done
[ "$(pactl get-default-sink)" = "tm_sink" ] || { echo "sink"; exit 1; }
[ "$(pactl get-default-source)" = "tm_mic" ] || { echo "source"; exit 1; }
pactl get-source-mute tm_mic | grep -q "Mute: yes" || { echo "mic not muted"; exit 1; }
[ -f /etc/opt/chrome/policies/managed/tm.json ] || { echo "policy"; exit 1; }
[ "$(df -k /dev/shm | awk 'NR==2 {print $2}')" -ge 2000000 ] || { echo "shm below 2g: run with --shm-size=2g"; exit 1; }
echo "SELFCHECK OK"
