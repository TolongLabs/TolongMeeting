#!/usr/bin/env bash
# run-worker.sh --name <container> --identity <id> --data <NN> [--vnc-port <port>] [--network <container>] [--full-view] [--image <tag>] -- <script.mjs> [args]
set -euo pipefail
. "$(dirname "$0")/env.sh"
. "$SPIKES_REPO/00-setup/worker/versions.env"

name="" identity="" data="" port=6080 network="" full_view=0 image="tm-spike-worker:$CHROME_VERSION"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --identity) identity="$2"; shift 2 ;;
    --data) data="$2"; shift 2 ;;
    --vnc-port) port="$2"; shift 2 ;;
    --network) network="$2"; shift 2 ;;
    --full-view) full_view=1; shift ;;
    --image) image="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
: "${name:?--name required}" "${identity:?--identity required}" "${data:?--data required}"
[ $# -gt 0 ] || { echo "script missing after --" >&2; exit 2; }

prof="$SPIKES_ROOT/profiles/$identity"
[ -d "$prof/work" ] || { echo "run new-identity.sh $identity first" >&2; exit 1; }
mkdir -p "$SPIKES_ROOT/data/$data/results" "$SPIKES_ROOT/data/$data/private"
chmod 777 "$SPIKES_ROOT/data/$data" "$SPIKES_ROOT/data/$data/results" "$SPIKES_ROOT/data/$data/private"

args=(-d --name "$name" --shm-size=2g
  -v "$prof/work:/profile"
  -v "$prof/machine-id:/etc/machine-id:ro"
  -v "$SPIKES_ROOT/data/$data:/data"
  -v "$SPIKES_REPO:/spikes:ro")
if [ -n "$network" ]; then
  args+=(--network "container:${network#container:}")
else
  # Local adaptation: every published port binds to loopback only.
  args+=(--hostname "tm-$identity" -p "127.0.0.1:$port:6080")
  [ "$full_view" = 1 ] && args+=(-p "127.0.0.1:$((port + 1)):6081")
fi
[ "$full_view" = 1 ] && args+=(-e FULL_VIEW=1)

docker run "${args[@]}" "$image" "$@"
