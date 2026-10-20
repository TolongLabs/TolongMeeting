#!/usr/bin/env bash
# sync.sh push | sync.sh pull <NN>-<slug>
# Local adaptation: the repo's spikes/ is bind-mounted into the container, so push is a no-op.
set -euo pipefail
. "$(dirname "$0")/env.sh"
case "${1:-}" in
  push) echo "nothing to push: $SPIKES_REPO is mounted at /spikes" ;;
  pull)
    slug="${2:?usage: sync.sh pull <NN>-<slug>}"
    nn="${slug%%-*}"
    mkdir -p "$SPIKES_REPO/$slug/data"
    cp -a "$SPIKES_ROOT/data/$nn/results/." "$SPIKES_REPO/$slug/data/"
    echo "pulled $SPIKES_ROOT/data/$nn/results/ -> spikes/$slug/data/" ;;
  *) echo "usage: sync.sh push | pull <NN>-<slug>" >&2; exit 2 ;;
esac
