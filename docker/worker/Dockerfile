# The meeting worker image. Build from the repository root with scripts/build-worker-image.sh
# (it passes every key of docker/worker/versions.env as a build argument).
# Run with --shm-size=2g: Chrome's WebRTC tabs crash on Docker's 64 MB default. run-job.sh does this.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim

ARG CHROME_VERSION
ARG FFMPEG_VERSION
ARG X11VNC_VERSION
ARG WEBSOCKIFY_VERSION
ARG XPRINTIDLE_VERSION
ARG BUN_VERSION
# SHA-256 of bun-linux-x64.zip for BUN_VERSION, pinned in versions.env (not read from the download origin).
ARG BUN_SHA256
ARG PLAYWRIGHT_VERSION
# SHA-256 of google-chrome-stable_${CHROME_VERSION}-1_amd64.deb. Change it together with CHROME_VERSION
# (spikes/02-browser/REPORT.md holds the value for the current pin).
ARG CHROME_DEB_SHA256=8fbd2ae69cdf7ee98b7513c3396a7b5e06f974f8625fdd590df3091dd0c3e9de
# The WeChat QR bridge needs Python 3.12 (numpy 2.5.4 requires it; Debian 12 ships 3.11), so uv fetches it.
# The wheel versions and hashes are in docker/worker/wechat-requirements.txt.
ARG UV_VERSION=0.12.1
ARG UV_SHA256=90b2f223fb69d19db49e117da601f64978593417988530aa733d456141b4bcbb
ARG PYTHON_VERSION=3.12.13

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox pulseaudio pulseaudio-utils \
      "x11vnc=${X11VNC_VERSION}" "websockify=${WEBSOCKIFY_VERSION}" "xprintidle=${XPRINTIDLE_VERSION}" x11-utils \
      "ffmpeg=${FFMPEG_VERSION}" libgl1-mesa-dri \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      jq curl ca-certificates unzip iptables \
 && curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}-1_amd64.deb" \
 && echo "${CHROME_DEB_SHA256}  /tmp/chrome.deb" | sha256sum -c - \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list \
 && rm -rf /var/lib/apt/lists/*

# Bun, from the release zip, checked against BUN_SHA256 from versions.env.
RUN [ -n "${BUN_SHA256}" ] \
 && cd /tmp \
 && curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  bun-linux-x64.zip" | sha256sum -c - \
 && unzip -q -j bun-linux-x64.zip bun-linux-x64/bun -d /usr/local/bin \
 && chmod 755 /usr/local/bin/bun \
 && ln -s bun /usr/local/bin/bunx \
 && rm -f bun-linux-x64.zip \
 && [ "$(bun --version)" = "${BUN_VERSION}" ]

# Python venv for the WeChat QR bridge (OpenCV's WeChat detector). uv is only needed at build time.
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_CACHE_DIR=/tmp/uv-cache
COPY docker/worker/wechat-requirements.txt /tmp/wechat-requirements.txt
RUN curl -fsSLo /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 uv-x86_64-unknown-linux-gnu/uv \
 && uv python install --no-bin "${PYTHON_VERSION}" \
 && uv venv --python "${PYTHON_VERSION}" /opt/wechat-venv \
 && uv pip install --python /opt/wechat-venv/bin/python --require-hashes --no-deps --only-binary :all: -r /tmp/wechat-requirements.txt \
 && rm -rf /usr/local/bin/uv /tmp/uv.tar.gz /tmp/uv-cache /tmp/wechat-requirements.txt

# The four WeChat QR model files (WeChatCV/opencv_3rdparty, branch wechat_qrcode), checked as in spikes/03-qr/fetch-models.sh.
RUN mkdir -p /opt/wechat-models && cd /opt/wechat-models \
 && for f in detect.prototxt detect.caffemodel sr.prototxt sr.caffemodel; do \
      curl -fsSLO "https://raw.githubusercontent.com/WeChatCV/opencv_3rdparty/wechat_qrcode/$f"; \
    done \
 && printf '%s  %s\n' \
      e8acfc395caf443a47f15686a9b9207b36cb8f7e6ceb8fbaf6466665e68a9466 detect.prototxt \
      cc49b8c9babaf45f3037610fe499df38c8819ebda29e90ca9f2e33270f6ef809 detect.caffemodel \
      8ae41acba97e8b4a8e741ee350481e49b8e01d787193f470a4c95ee1c02d5b61 sr.prototxt \
      e5d36889d8e6ef2f1c1f515f807cec03979320ac81792cd8fb927c31fd658ae3 sr.caffemodel \
    | sha256sum -c -

COPY docker/worker/chrome-policy.json /etc/opt/chrome/policies/managed/tm.json
COPY docker/worker/openbox/rc.xml /etc/xdg/openbox/rc.xml
COPY docker/worker/pulse/default.pa /etc/pulse/default.pa
# Private-range egress rules for runs outside the server firewall; the local holder and home-route sidecar run it as root.
COPY docker/egress/deny-private.sh /usr/local/bin/deny-private.sh
RUN chmod 0755 /usr/local/bin/deny-private.sh

# uid 1000 matches the usual host user, so the bind-mounted data and profile roots are writable.
RUN userdel -r node && useradd -m -u 1000 -s /bin/bash tm && mkdir /app && chown tm:tm /app
WORKDIR /app
COPY --chown=tm:tm . /app

USER tm
# The image is also the test runner (entrypoint modes `test` and `unit` need @playwright/test and the other dev
# dependencies), so dev dependencies stay installed; `bun build` runs here as well, so one install serves both.
# cli.ts arrives in Task 18; until then the image is built without dist/. build:worker also builds dist/signin.js.
RUN bun install --frozen-lockfile \
 && [ "$(node -p "require('/app/node_modules/playwright/package.json').version")" = "${PLAYWRIGHT_VERSION}" ] \
 && if [ -f packages/worker/src/cli.ts ]; then bun run build:worker; fi \
 && rm -rf "$HOME/.bun/install/cache"

# The QR bridge (packages/worker/src/qr/wechat.ts) reads TM_WECHAT_MODELS_DIR and TM_WECHAT_PYTHON.
ENV TM_SELECTORS_DIR=/app/config/selectors TM_IN_IMAGE=1 \
    TM_WECHAT_MODELS_DIR=/opt/wechat-models TM_WECHAT_PYTHON=/opt/wechat-venv/bin/python
ENTRYPOINT ["/app/docker/worker/entrypoint.sh"]
