#!/usr/bin/env bash
# measure-audio.sh <container> <seconds>: mean and max volume of tm_sink.monitor.
set -euo pipefail
c="${1:?usage: measure-audio.sh <container> <seconds>}"
s="${2:?usage: measure-audio.sh <container> <seconds>}"
docker exec "$c" ffmpeg -hide_banner -f pulse -i tm_sink.monitor -t "$s" -af volumedetect -f null - 2>&1 \
  | grep -E 'mean_volume|max_volume' | sed -E 's/.*(mean_volume|max_volume): (-?[0-9.inf]+) dB.*/\1: \2/'
