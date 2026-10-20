#!/usr/bin/env bash
set -euo pipefail

rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie

mkdir -p /tmp/pulse /tmp/xdg
chmod 700 /tmp/xdg
export XDG_RUNTIME_DIR=/tmp/xdg

Xvfb :99 -screen 0 3840x1080x24 -nolisten tcp &
until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.2; done

openbox &
pulseaudio --daemonize=yes --exit-idle-time=-1 -n -F /etc/pulse/tm.pa

x11vnc -display :99 -clip 1920x1080+1920+0 -localhost -forever -shared -nopw -quiet -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &

if [ "${FULL_VIEW:-0}" = "1" ]; then
  x11vnc -display :99 -localhost -forever -shared -nopw -quiet -rfbport 5901 &
  websockify --web /usr/share/novnc 6081 localhost:5901 &
fi

exec node "$@"
