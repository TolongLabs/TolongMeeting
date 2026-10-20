#!/bin/sh
# Checks the image against docker/worker/versions.env. Runs inside the image: entrypoint.sh starts PulseAudio first.
set -eu
. /app/docker/worker/versions.env
google-chrome --version | grep -q " $CHROME_VERSION" || { echo "chrome mismatch"; exit 1; }
[ "$(node --version)" = "v$NODE_VERSION" ] || { echo "node mismatch"; exit 1; }
[ "$(bun --version)" = "$BUN_VERSION" ] || { echo "bun mismatch"; exit 1; }
[ "$(dpkg-query -W -f='${Version}' ffmpeg)" = "$FFMPEG_VERSION" ] || { echo "ffmpeg mismatch"; exit 1; }
[ "$(node -p "require('/app/node_modules/playwright/package.json').version")" = "$PLAYWRIGHT_VERSION" ] || { echo "playwright mismatch"; exit 1; }
[ "$(dpkg-query -W -f='${Version}' x11vnc)" = "$X11VNC_VERSION" ] || { echo "x11vnc mismatch"; exit 1; }
[ "$(dpkg-query -W -f='${Version}' websockify)" = "$WEBSOCKIFY_VERSION" ] || { echo "websockify mismatch"; exit 1; }
[ "$(dpkg-query -W -f='${Version}' xprintidle)" = "$XPRINTIDLE_VERSION" ] || { echo "xprintidle mismatch"; exit 1; }
command -v x11vnc >/dev/null || { echo "x11vnc missing"; exit 1; }
command -v websockify >/dev/null || { echo "websockify missing"; exit 1; }
command -v xprintidle >/dev/null || { echo "xprintidle missing"; exit 1; }
# xprintidle needs the MIT-SCREEN-SAVER extension, which Xvfb may or may not offer: ask a real Xvfb, the way the desk pause does.
xvfb_log=$(mktemp)
xvfb_display=$(mktemp)
Xvfb -displayfd 3 -screen 0 320x200x24 -nolisten tcp 3>"$xvfb_display" >"$xvfb_log" 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true; rm -f "$xvfb_log" "$xvfb_display"' EXIT
for _ in $(seq 1 50); do
  [ -s "$xvfb_display" ] && break
  kill -0 "$xvfb_pid" 2>/dev/null || { echo "xvfb exited: $(cat "$xvfb_log")"; exit 1; }
  sleep 0.1
done
[ -s "$xvfb_display" ] || { echo "xvfb did not start within 5 s"; exit 1; }
idle=$(DISPLAY=":$(tr -d '\n' <"$xvfb_display")" xprintidle) || { echo "xprintidle failed on Xvfb"; exit 1; }
case "$idle" in '' | *[!0-9]*) echo "xprintidle printed '$idle', not a number of ms"; exit 1 ;; esac
kill "$xvfb_pid" 2>/dev/null || true
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
