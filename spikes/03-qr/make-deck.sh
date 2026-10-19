#!/usr/bin/env bash
# Synthesise the test deck and stage frames (see make_frames.py). Usage: make-deck.sh <frames-dir>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -eq 1 ] || { echo "usage: $0 <frames-dir>" >&2; exit 2; }
"$here/.venv/bin/python" "$here/make_frames.py" --out "$1"
