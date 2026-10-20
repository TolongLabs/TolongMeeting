#!/bin/sh
# Egress rules for a worker that does NOT go through the server firewall (docker/firewall/worker-egress.sh): a local run
# on the member's PC (network holder, plan 08 Task 8) and a home-route run (tm-home sidecar, Task 13). Runs as root with
# NET_ADMIN inside the network namespace the worker shares. Safe to run again. POSIX sh (Alpine and Debian).
#
#   deny-private.sh [--print] [--out-iface <iface>] [--allow-tcp <host-or-ip>:<port>]... [--hold]
#
# --print       print the commands instead of running them; names are not resolved
# --out-iface   apply every rule to traffic leaving through <iface> only (the home-route tunnel); default: all
# --allow-tcp   let this TCP destination through before the private ranges are rejected (the companion's relay);
#               host names are resolved with `getent ahostsv4`, and an unresolvable name is an error
# --hold        after the rules are in, `exec sleep infinity` (the holder keeps the network namespace alive)
#
# Fail closed and atomic (the lessons of docker/firewall/worker-egress.sh):
#  1. the chain TM-DENY-PRIVATE is flushed and refilled with every rule in ONE iptables-restore --noflush transaction,
#     so a reader sees the old chain or the new one, never an empty or half-built one;
#  2. only then does OUTPUT jump to it (a hook to a chain that is still being built protects nothing);
#  3. the chain is read back: its rule count, its last rule (the last range rejected) and the hook at position 1 must be
#     what was built, else the script exits non-zero and `--hold` never starts;
#  4. IPv6 gets the same treatment with ip6tables. It may be skipped ONLY when the kernel or ip6tables has no IPv6
#     support AND net.ipv6.conf.all.disable_ipv6 is 1 (no IPv6 at all); in any other case a failure is fatal.
# Loopback (-o lo) and replies to connections opened from outside (the published noVNC port) are accepted first, so the
# worker's own X, PulseAudio and noVNC traffic and the replies to the member's browser still work.
set -eu

CHAIN=TM-DENY-PRIVATE
nl='
'
# RFC 1918, link-local and cloud metadata, carrier-grade NAT (also Alibaba Cloud's 100.100.100.200), "this network",
# loopback, IETF protocol assignments, benchmarking, multicast plus reserved space. Same list as worker-egress.sh.
DENY4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8 127.0.0.0/8 192.0.0.0/24 198.18.0.0/15 224.0.0.0/3"
LAST4=224.0.0.0/3
# Unspecified, link-local, unique local, deprecated site-local, v4-mapped, NAT64 well-known prefix, multicast.
DENY6="::/128 fe80::/10 fc00::/7 fec0::/10 ::ffff:0:0/96 64:ff9b::/96 ff00::/8"
LAST6=ff00::/8

die() {
  echo "deny-private: $*" >&2
  exit 1
}
usage() {
  echo "usage: deny-private.sh [--print] [--out-iface <iface>] [--allow-tcp <host-or-ip>:<port>]... [--hold]" >&2
  exit 2
}

print=0
hold=0
iface=
allow=
while [ $# -gt 0 ]; do
  case $1 in
    --print) print=1 ;;
    --hold) hold=1 ;;
    --out-iface)
      [ $# -ge 2 ] || usage
      iface=$2
      shift
      ;;
    --allow-tcp)
      [ $# -ge 2 ] || usage
      allow="$allow$2$nl"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

if [ -n "$iface" ]; then
  printf '%s\n' "$iface" | grep -Eq '^[A-Za-z0-9._-]{1,15}$' || die "bad interface name: $iface"
  oif="-o $iface "
else
  oif=
fi

# Rule bodies for one family, one per line: allow-tcp, then replies, then loopback, then the rejects.
r4=
r6=
add4() { r4="$r4-A $CHAIN $oif$*$nl"; }
add6() { r6="$r6-A $CHAIN $oif$*$nl"; }

is_ipv4() { printf '%s\n' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }

old_ifs=$IFS
IFS=$nl
for entry in $allow; do
  IFS=$old_ifs
  host=${entry%:*}
  port=${entry##*:}
  [ "$host" != "$entry" ] || die "--allow-tcp needs <host-or-ip>:<port>, got: $entry"
  printf '%s\n' "$port" | grep -Eq '^[0-9]{1,5}$' && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "bad port in: $entry"
  if is_ipv4 "$host" || { [ "$print" = 1 ] && printf '%s\n' "$host" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; }; then
    ips=$host
  else
    printf '%s\n' "$host" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || die "bad host in: $entry"
    ips=$(getent ahostsv4 "$host" | awk '{ print $1 }' | sort -u)
    [ -n "$ips" ] || die "cannot resolve $host"
  fi
  for ip in $ips; do
    add4 "-p tcp -d $ip --dport $port -j ACCEPT"
  done
  IFS=$nl
done
IFS=$old_ifs

add4 "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
add6 "-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
if [ -z "$iface" ]; then
  add4 "-o lo -j ACCEPT"
  add6 "-o lo -j ACCEPT"
fi
for range in $DENY4; do add4 "-d $range -j REJECT"; done
for range in $DENY6; do add6 "-d $range -j REJECT"; done

if [ "$print" = 1 ]; then
  printf '%s' "$r4" | sed 's/^/iptables /'
  echo "iptables -I OUTPUT 1 -j $CHAIN"
  printf '%s' "$r6" | sed 's/^/ip6tables /'
  echo "ip6tables -I OUTPUT 1 -j $CHAIN"
  [ "$hold" = 1 ] && echo "exec sleep infinity"
  exit 0
fi

# apply <iptables|ip6tables> <rules> <last range>
apply() {
  tool=$1
  rules=$2
  last=$3
  want=$(printf '%s' "$rules" | grep -c .)

  "${tool}-restore" -w 30 --noflush <<RULES
*filter
:$CHAIN - [0:0]
-F $CHAIN
$rules
COMMIT
RULES

  "$tool" -w 30 -C OUTPUT -j "$CHAIN" 2>/dev/null || "$tool" -w 30 -I OUTPUT 1 -j "$CHAIN"

  built=$("$tool" -w 30 -S "$CHAIN")
  got=$(printf '%s\n' "$built" | grep -c '^-A ')
  [ "$got" = "$want" ] || die "$CHAIN has $got $tool rules, expected $want"
  case $(printf '%s\n' "$built" | tail -n 1) in
    "-A $CHAIN "*"-d $last "*"-j REJECT"*) ;;
    *) die "the last rule of $CHAIN ($tool) is not the REJECT of $last" ;;
  esac
  [ "$("$tool" -w 30 -S OUTPUT | sed -n 2p)" = "-A OUTPUT -j $CHAIN" ] || die "OUTPUT ($tool) does not jump to $CHAIN first"
}

command -v iptables >/dev/null 2>&1 || die "iptables is not installed"
command -v iptables-restore >/dev/null 2>&1 || die "iptables-restore is not installed"
apply iptables "$r4" "$LAST4"

if command -v ip6tables >/dev/null 2>&1 && command -v ip6tables-restore >/dev/null 2>&1 && ip6tables -w 30 -L -n >/dev/null 2>&1; then
  apply ip6tables "$r6" "$LAST6"
elif [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || true)" = 1 ]; then
  echo "deny-private: no ip6tables support, but IPv6 is disabled (net.ipv6.conf.all.disable_ipv6=1): IPv6 rules skipped" >&2
else
  die "ip6tables is unavailable and IPv6 is not disabled (net.ipv6.conf.all.disable_ipv6 is not 1)"
fi

[ "$hold" = 1 ] && exec sleep infinity
exit 0
