#!/bin/sh
# Picks and verifies the member's home exit node in `tailscale status --json`, read on stdin. The sidecar alone does this:
# the worker has no Tailscale socket, so it cannot change the exit node. A node counts only when BOTH its stable node id
# (TM_EXIT_NODE_ID, from the member's stored home node) and its hostname (TM_EXIT_NODE_HOSTNAME, the keyed `tm-home-...`
# name) match, so another device that registered the same hostname, or the same id under another name, is never used.
#
#   exit-node.sh select           prints the node's Tailscale IPv4 address; exit 1 when no online exit node matches
#   exit-node.sh verify <ipv4>    exit 0 only when status shows that node, online, as the exit node in use
set -eu
: "${TM_EXIT_NODE_ID:?}" "${TM_EXIT_NODE_HOSTNAME:?}"

# The peer that is the member's home node: id and hostname match, it offers itself as an exit node and is online.
PEER='[(.Peer // {}) | to_entries[].value
  | select(.ID == $id and .HostName == $host and .ExitNodeOption == true and .Online == true)]'
IPV4='[.TailscaleIPs[]? | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"))][0]'

case ${1:-} in
  select)
    ip=$(jq -r --arg id "$TM_EXIT_NODE_ID" --arg host "$TM_EXIT_NODE_HOSTNAME" "$PEER | if length == 1 then .[0] | $IPV4 // empty else empty end")
    [ -n "$ip" ] || exit 1
    printf '%s\n' "$ip"
    ;;
  verify)
    [ $# -eq 2 ] || exit 2
    jq -e --arg id "$TM_EXIT_NODE_ID" --arg host "$TM_EXIT_NODE_HOSTNAME" --arg ip "$2" "
      .BackendState == \"Running\"
      and .ExitNodeStatus.ID == \$id and .ExitNodeStatus.Online == true
      and (.ExitNodeStatus.TailscaleIPs // [] | map(split(\"/\")[0]) | index(\$ip)) != null
      and ($PEER | length) == 1" >/dev/null
    ;;
  *)
    echo "usage: exit-node.sh select | verify <ipv4>" >&2
    exit 2
    ;;
esac
