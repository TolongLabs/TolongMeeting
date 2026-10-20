#!/usr/bin/env bash
# Modes: selfcheck | test <playwright filter> | unit <bun test path> | seed --job <path> | --job <path> | --signin <path>
set -euo pipefail

usage() {
  echo "usage: entrypoint.sh selfcheck | test <filter> | unit <path> | seed --job <path> | --job <path> | --signin <path>" >&2
  exit 2
}

[ $# -ge 1 ] || usage
mode=$1
case "$mode" in
  selfcheck | test | unit) ;;
  seed) [ $# -eq 3 ] && [ "$2" = "--job" ] || usage ;;
  --job | --signin) [ $# -eq 2 ] || usage ;;
  *) usage ;;
esac

# PulseAudio keeps its socket under XDG_RUNTIME_DIR; ffmpeg, pactl and Chrome find it through the same variable.
mkdir -p /tmp/xdg
chmod 700 /tmp/xdg
export XDG_RUNTIME_DIR=/tmp/xdg

pulseaudio --daemonize=no --exit-idle-time=-1 &
pulse=$!
child=0
stopping=0

# Forward docker stop (SIGTERM) to the running command so the worker can stop its recording cleanly.
# `stopping` also stops the job from starting (or from moving on to the next stage) after a TERM.
forward() {
  stopping=1
  if [ "$child" -ne 0 ]; then kill -TERM "$child" 2>/dev/null || true; fi
}
trap forward TERM INT
trap 'kill "$pulse" 2>/dev/null || true' EXIT

# Runs a command in the background and waits for it, so the traps above fire while it runs. Returns its exit code.
# After a TERM it does not start the command and returns 143.
run() {
  local rc=0
  if [ "$stopping" -ne 0 ]; then return 143; fi
  "$@" &
  child=$!
  wait "$child" || rc=$?
  # A trapped signal ends `wait` early with a code above 128. Wait again for the command's own exit code;
  # an unchanged code means it was already collected (or the command really exited with it), so it stands.
  while [ "$rc" -gt 128 ]; do
    local again=0
    wait "$child" || again=$?
    [ "$again" -ne 127 ] && [ "$again" -ne "$rc" ] || break
    rc=$again
  done
  child=0
  return "$rc"
}

for _ in $(seq 1 50); do
  [ "$stopping" -eq 0 ] || break
  pactl info >/dev/null 2>&1 && break
  kill -0 "$pulse" 2>/dev/null || { echo "pulseaudio exited during start" >&2; exit 1; }
  sleep 0.2
done
# A TERM during the wait stops the job; the EXIT trap stops PulseAudio.
if [ "$stopping" -ne 0 ]; then echo "stopped while waiting for pulseaudio" >&2; exit 143; fi
pactl info >/dev/null 2>&1 || { echo "pulseaudio did not answer within 10 s" >&2; exit 1; }

cd /app

run_job() {
  local job=$1 worker=0 pipeline=0 data_dir
  data_dir=$(jq -er '.dataDir' "$job")
  # node directly (not `bun run tm-worker`), so docker stop's SIGTERM reaches the worker.
  run node packages/worker/dist/cli.js --job "$job" || worker=$?
  # With a control URL the pipeline consumer (milestone 1C) post-processes the recording instead.
  # After a TERM the container is being stopped, so the pipeline is skipped.
  if [ "$stopping" -eq 0 ] && jq -e '.control == null' "$job" >/dev/null && [ -f "$data_dir/recording/meeting.mkv" ]; then
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
  # A sign-in container (no meeting): the member signs in through the remote view, then a checkpoint is written.
  --signin) run node packages/worker/dist/signin.js "$2" ;;
esac
