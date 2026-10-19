#!/usr/bin/env bash
# Modes: selfcheck | test <playwright filter> | unit <bun test path> | seed --job <path> | --job <path>
set -euo pipefail

usage() {
  echo "usage: entrypoint.sh selfcheck | test <filter> | unit <path> | seed --job <path> | --job <path>" >&2
  exit 2
}

[ $# -ge 1 ] || usage
mode=$1
case "$mode" in
  selfcheck | test | unit) ;;
  seed) [ $# -eq 3 ] && [ "$2" = "--job" ] || usage ;;
  --job) [ $# -eq 2 ] || usage ;;
  *) usage ;;
esac

# PulseAudio keeps its socket under XDG_RUNTIME_DIR; ffmpeg, pactl and Chrome find it through the same variable.
mkdir -p /tmp/xdg
chmod 700 /tmp/xdg
export XDG_RUNTIME_DIR=/tmp/xdg

pulseaudio --daemonize=no --exit-idle-time=-1 &
pulse=$!
child=0

# Forward docker stop (SIGTERM) to the running command so the worker can stop its recording cleanly.
forward() {
  if [ "$child" -ne 0 ]; then kill -TERM "$child" 2>/dev/null || true; fi
}
trap forward TERM INT
trap 'kill "$pulse" 2>/dev/null || true' EXIT

# Runs a command in the background and waits for it, so the traps above fire while it runs. Returns its exit code.
run() {
  local rc=0
  "$@" &
  child=$!
  wait "$child" || rc=$?
  while kill -0 "$child" 2>/dev/null; do wait "$child" || rc=$?; done
  child=0
  return "$rc"
}

for _ in $(seq 1 50); do
  pactl info >/dev/null 2>&1 && break
  kill -0 "$pulse" 2>/dev/null || { echo "pulseaudio exited during start" >&2; exit 1; }
  sleep 0.2
done
pactl info >/dev/null 2>&1 || { echo "pulseaudio did not answer within 10 s" >&2; exit 1; }

cd /app

run_job() {
  local job=$1 worker=0 pipeline=0 data_dir
  data_dir=$(jq -er '.dataDir' "$job")
  run bun run tm-worker -- --job "$job" || worker=$?
  # With a control URL the pipeline consumer (milestone 1C) post-processes the recording instead.
  if jq -e '.control == null' "$job" >/dev/null && [ -f "$data_dir/recording/meeting.mkv" ]; then
    run bun run tm-pipeline -- --job "$job" || pipeline=$?
  fi
  if [ "$worker" -ne 0 ]; then return "$worker"; fi
  return "$pipeline"
}

# set -e ends the script with the failing command's exit code; the EXIT trap then stops PulseAudio.
case "$mode" in
  selfcheck) run /app/docker/worker/selfcheck.sh ;;
  test) shift; run bunx playwright test -c packages/worker/playwright.config.ts "$@" ;;
  unit) shift; run bun test "$@" ;;
  seed) run node packages/worker/dist/cli.js --seed --job "$3" ;;
  --job) run_job "$2" ;;
esac
