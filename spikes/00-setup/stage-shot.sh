#!/usr/bin/env bash
# stage-shot.sh <container> <out.png>: grab the stage (left half) at 1920x1080.
set -euo pipefail
c="${1:?usage: stage-shot.sh <container> <out.png>}"
out="${2:?usage: stage-shot.sh <container> <out.png>}"
docker exec "$c" ffmpeg -loglevel error -y -f x11grab -video_size 1920x1080 -i :99.0+0,0 -frames:v 1 /tmp/stage-shot.png
docker cp "$c:/tmp/stage-shot.png" "$out"
