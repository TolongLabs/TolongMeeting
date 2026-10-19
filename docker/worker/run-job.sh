#!/usr/bin/env bash
# Starts one worker container. Usage: run-job.sh <job.json> [seed]
# Needs TM_DATA_ROOT, TM_PROFILE_ROOT and TM_MASTER_KEY_FILE in the environment (absolute paths).
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

# A fixed machine id per identity keeps the browser fingerprint stable across runs.
machine_id_file="$TM_PROFILE_ROOT/$id/machine-id"
if [ ! -f "$machine_id_file" ]; then
  mkdir -p "$TM_PROFILE_ROOT/$id"
  printf '%s\n' "$(printf %s "$id" | sha256sum | cut -c1-32)" >"$machine_id_file"
fi

args=(
  run --rm --shm-size=2g --hostname "tm-${id:0:20}"
  --mount "type=bind,src=$machine_id_file,dst=/etc/machine-id,readonly"
  --mount "type=bind,src=$TM_DATA_ROOT,dst=$TM_DATA_ROOT"
  --mount "type=bind,src=$TM_PROFILE_ROOT,dst=$TM_PROFILE_ROOT"
  --mount "type=bind,src=$TM_MASTER_KEY_FILE,dst=/run/secrets/tm_master_key,readonly"
  --mount "type=bind,src=$job,dst=/job/job.json,readonly"
  -e "TM_DATA_ROOT=$TM_DATA_ROOT" -e "TM_PROFILE_ROOT=$TM_PROFILE_ROOT" -e TM_MASTER_KEY_FILE=/run/secrets/tm_master_key
)
if [ "$mode" = seed ]; then args+=(-p 127.0.0.1:5900:5900); fi
args+=("${TM_WORKER_IMAGE_REF:-tm-worker:dev}")
if [ "$mode" = seed ]; then args+=(seed --job /job/job.json); else args+=(--job /job/job.json); fi

exec docker "${args[@]}"
