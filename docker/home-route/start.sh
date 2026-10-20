#!/bin/sh
# Entrypoint of the home-route sidecar. Environment (all set by the Docker gate's fixed body): TS_* for containerboot (the
# auth key is a FILE, TS_AUTHKEY=file:/run/tm/authkey, never the key itself) and TM_EXIT_NODE_ID / TM_EXIT_NODE_HOSTNAME,
# the member's home node.
#
#  1. deny-private.sh --out-iface tailscale0 comes first, before anything else starts, so no packet that leaves through
#     the tunnel reaches a private range (the exit node's own LAN, cloud metadata). Rules on an interface that does not
#     exist yet are fine; they bite the moment tailscale0 appears. A failure here ends the container.
#  2. containerboot starts tailscaled and logs in with the key file.
#  3. once the backend is Running, the exit node is chosen HERE by node id and hostname (exit-node.sh), set with
#     `tailscale set`, and checked again on every pass. /tmp/tm-ready exists only while status shows exactly that node as
#     the online exit node in use; the container's health check is that file.
# Tailscale drops traffic rather than falling back when the exit node goes away, so an outage mid-meeting never sends
# traffic out of the server's own address.
set -eu
: "${TM_EXIT_NODE_ID:?}" "${TM_EXIT_NODE_HOSTNAME:?}"

deny-private.sh --out-iface tailscale0

rm -f /tmp/tm-ready
containerboot &
boot=$!
trap 'kill -TERM "$boot" 2>/dev/null || :' TERM INT

(
  chosen=
  while kill -0 "$boot" 2>/dev/null; do
    if status=$(tailscale status --json 2>/dev/null) && [ "$(printf '%s' "$status" | jq -r '.BackendState')" = Running ]; then
      if [ -z "$chosen" ]; then
        if ip=$(printf '%s' "$status" | exit-node.sh select) && tailscale set --exit-node="$ip" --exit-node-allow-lan-access=true; then
          chosen=$ip
        fi
      elif printf '%s' "$status" | exit-node.sh verify "$chosen"; then
        touch /tmp/tm-ready
      else
        rm -f /tmp/tm-ready
      fi
    else
      rm -f /tmp/tm-ready
    fi
    sleep 1
  done
) &
poll=$!

status=0
wait "$boot" || status=$?
kill "$poll" 2>/dev/null || :
exit "$status"
