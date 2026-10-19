#!/usr/bin/env bash
# Download the four WeChat QR model files (WeChatCV/opencv_3rdparty, branch wechat_qrcode) into ./models and verify SHA-256.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$here/models"
base=https://raw.githubusercontent.com/WeChatCV/opencv_3rdparty/wechat_qrcode
cd "$here/models"
for f in detect.prototxt detect.caffemodel sr.prototxt sr.caffemodel; do
  [ -s "$f" ] || curl -fsSL -o "$f" "$base/$f"
done
sha256sum -c - <<'SUMS'
e8acfc395caf443a47f15686a9b9207b36cb8f7e6ceb8fbaf6466665e68a9466  detect.prototxt
cc49b8c9babaf45f3037610fe499df38c8819ebda29e90ca9f2e33270f6ef809  detect.caffemodel
8ae41acba97e8b4a8e741ee350481e49b8e01d787193f470a4c95ee1c02d5b61  sr.prototxt
e5d36889d8e6ef2f1c1f515f807cec03979320ac81792cd8fb927c31fd658ae3  sr.caffemodel
SUMS
