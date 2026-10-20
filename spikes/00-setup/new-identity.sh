#!/usr/bin/env bash
# new-identity.sh <id>: working profile, checkpoints dir and a fixed machine-id for one identity.
set -euo pipefail
. "$(dirname "$0")/env.sh"
id="${1:?usage: new-identity.sh <id>}"
dir="$SPIKES_ROOT/profiles/$id"
mkdir -p "$dir/work" "$dir/checkpoints"
chmod 777 "$dir/work" "$dir/checkpoints" # the container's node user is uid 1000; harmless when the host user is uid 1000 too
if [ ! -s "$dir/machine-id" ]; then
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$dir/machine-id"
  echo >> "$dir/machine-id"
fi
echo "identity $id ready at $dir"
