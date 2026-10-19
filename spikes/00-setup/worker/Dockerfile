ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim
ARG CHROME_VERSION
ARG PLAYWRIGHT_VERSION
ARG FFMPEG_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox pulseaudio pulseaudio-utils x11vnc novnc websockify wmctrl x11-utils \
      ffmpeg=${FFMPEG_VERSION} libgl1-mesa-dri fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      sqlite3 curl ca-certificates \
 && curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
 && sha256sum /tmp/chrome.deb | tee /opt/chrome-deb.sha256 \
 && apt-get install -y /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list \
 && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix / --no-save --no-fund playwright@${PLAYWRIGHT_VERSION}
ENV DISPLAY=:99 PULSE_SERVER=unix:/tmp/pulse/native NODE_PATH=/node_modules
COPY chrome-policy.json /etc/opt/chrome/policies/managed/tm-policy.json
COPY openbox-rc.xml /etc/xdg/openbox/rc.xml
COPY default.pa /etc/pulse/tm.pa
COPY entrypoint.sh /opt/spike/entrypoint.sh
USER node
ENTRYPOINT ["/opt/spike/entrypoint.sh"]
