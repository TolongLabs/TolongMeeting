#!/usr/bin/env bash
# Decode every condition with both decoders, pinned to one CPU. Usage: run-decode.sh <work-dir> <out-csv> [cpu]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1"; out="$2"; cpu="${3:-3}"
rm -f "$out"
for c in A B C; do
  rect="$(cat "$work/frames/rect-$c.txt")"
  taskset -c "$cpu" node "$here/decode-zxing.mjs" --frames "$work/frames/$c" --rect "$rect" --out "$out" --tag "$c"
  taskset -c "$cpu" "$here/.venv/bin/python" "$here/decode_wechat.py" --frames "$work/frames/$c" --rect "$rect" --out "$out" --tag "$c"
done
