#!/usr/bin/env bash
# Starts one worker container. Usage: run-job.sh <job.json> [seed]
# Needs TM_DATA_ROOT, TM_PROFILE_ROOT and TM_MASTER_KEY_FILE in the environment (absolute paths).
# The container sees only this identity's profile directory and this job's dataDir, each at its host path.
# TM_WORKER_IMAGE_REF overrides the image (default tm-worker:dev).
set -euo pipefail

usage() {
  echo "usage: run-job.sh <job.json> [seed]" >&2
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
job=$(realpath -- "$1")
mode=${2:-run}
case "$mode" in run | seed) ;; *) usage ;; esac

: "${TM_DATA_ROOT:?set TM_DATA_ROOT}" "${TM_PROFILE_ROOT:?set TM_PROFILE_ROOT}" "${TM_MASTER_KEY_FILE:?set TM_MASTER_KEY_FILE}"
for var in TM_DATA_ROOT TM_PROFILE_ROOT TM_MASTER_KEY_FILE; do
  case "${!var}" in /*) ;; *) echo "$var must be an absolute path" >&2; exit 2 ;; esac
done

id=$(jq -er '.identity.id' "$job")
# The id becomes a directory name and a hostname.
[[ $id =~ ^[A-Za-z0-9_-]+$ ]] || { echo "identity.id has characters outside A-Z a-z 0-9 _ -" >&2; exit 1; }

# The job's data directory must sit under TM_DATA_ROOT (an absolute path with no `..` part).
data_dir=$(jq -er '.dataDir' "$job")
case "$data_dir" in
  "$TM_DATA_ROOT"/*) ;;
  *) echo "dataDir must be inside TM_DATA_ROOT" >&2; exit 1 ;;
esac
case "/$data_dir/" in */../*) echo "dataDir must not contain .." >&2; exit 1 ;; esac
profile_dir="$TM_PROFILE_ROOT/$id"
mkdir -p "$data_dir" "$profile_dir"

# A fixed machine id per identity keeps the browser fingerprint stable across runs.
# Written to a temp file and renamed, so a crash never leaves a half-written id.
machine_id_file="$profile_dir/machine-id"
if [ ! -f "$machine_id_file" ]; then
  tmp=$(mktemp "$profile_dir/.machine-id.XXXXXX")
  printf '%s\n' "$(printf %s "$id" | sha256sum | cut -c1-32)" >"$tmp"
  chmod 644 "$tmp"
  mv -f -- "$tmp" "$machine_id_file"
fi

# --stop-timeout 60: docker stop sends SIGTERM and waits this long for the worker to finalise the recording and
# write its checkpoint. --cap-drop=ALL and no-new-privileges leave the container no extra privileges. Chrome runs with
# its own sandbox disabled in the container (Task 7); the container is the security boundary, so these limits matter.
args=(
  run --rm --shm-size=2g --hostname "tm-${id:0:20}"
  --stop-timeout 60 --security-opt no-new-privileges --cap-drop=ALL --pids-limit 2048
  --mount "type=bind,src=$machine_id_file,dst=/etc/machine-id,readonly"
  --mount "type=bind,src=$data_dir,dst=$data_dir"
  --mount "type=bind,src=$profile_dir,dst=$profile_dir"
  --mount "type=bind,src=$TM_MASTER_KEY_FILE,dst=/run/secrets/tm_master_key,readonly"
  --mount "type=bind,src=$job,dst=/job/job.json,readonly"
  -e "TM_DATA_ROOT=$TM_DATA_ROOT" -e "TM_PROFILE_ROOT=$TM_PROFILE_ROOT" -e TM_MASTER_KEY_FILE=/run/secrets/tm_master_key
)
if [ "$mode" = seed ]; then args+=(-p 127.0.0.1:5900:5900); fi
args+=("${TM_WORKER_IMAGE_REF:-tm-worker:dev}")
if [ "$mode" = seed ]; then args+=(seed --job /job/job.json); else args+=(--job /job/job.json); fi

exec docker "${args[@]}"
