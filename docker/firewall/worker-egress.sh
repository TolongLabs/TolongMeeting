#!/bin/sh
# Egress rules for the tm-workers network: bridge tm-workers0, 172.30.0.0/24, Caddy at 172.30.0.2.
# Run as root at boot, BEFORE Docker (tm-worker-egress.service; docker.service.d/10-tm-egress.conf makes Docker wait for
# it). Safe to run again. Install: copy to /usr/local/sbin/tm-worker-egress.sh (mode 755).
#
# Fail closed and atomic:
#  1. the TM-WORKERS chain and Docker's DOCKER-USER chain are created if missing (Docker keeps both when it starts);
#  2. the chain is flushed, filled with every rule and ended with `-j DROP` in ONE iptables-restore transaction, so a
#     reader sees the old chain or the new one, never an empty or half-built one;
#  3. only then do DOCKER-USER and INPUT jump to it (a hook to a chain that is still being built would let traffic out);
#  4. the last rule is checked to be the DROP, and the script exits non-zero if it is not (Docker then does not start).
# IPv6: the tm-workers network has no IPv6 and every worker runs with net.ipv6.conf.all.disable_ipv6=1 (container-spec.ts),
# so there is no ip6tables ruleset; the sysctl is what keeps a worker off IPv6.
# Home-route sidecars (docker/home-route) sit on this network too. Their Tailscale node reaches the control plane and DERP
# over TCP 443 (allowed below); direct WireGuard UDP to other ports is dropped on purpose, so Tailscale falls back to DERP.
set -eu
BR=tm-workers0
CADDY=172.30.0.2
# -w waits for the xtables lock, which Docker also takes while it starts containers.
ipt() { iptables -w 30 "$@"; }

ipt -L DOCKER-USER -n >/dev/null 2>&1 || ipt -N DOCKER-USER
ipt -L TM-WORKERS -n >/dev/null 2>&1 || ipt -N TM-WORKERS

# Private ranges (other containers included), link-local, cloud metadata (100.64.0.0/10 covers metadata services such as
# Alibaba Cloud's 100.100.100.200), "this network" 0/8, loopback, IETF protocol assignments 192.0.0.0/24, benchmarking
# 198.18.0.0/15, and multicast plus reserved space 224.0.0.0/3.
DENY=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,0.0.0.0/8,127.0.0.0/8,192.0.0.0/24,198.18.0.0/15,224.0.0.0/3

iptables-restore -w 30 --noflush <<RULES
*filter
-F TM-WORKERS
-A TM-WORKERS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A TM-WORKERS -s $CADDY -p tcp --dport 6080 -j ACCEPT
-A TM-WORKERS -d $CADDY -p tcp --dport 443 -j ACCEPT
-A TM-WORKERS -d 1.1.1.1,8.8.8.8 -p udp --dport 53 -j RETURN
-A TM-WORKERS -d 1.1.1.1,8.8.8.8 -p tcp --dport 53 -j RETURN
-A TM-WORKERS -d $DENY -j DROP
-A TM-WORKERS -p tcp -m multiport --dports 443,8801:8810 -j RETURN
-A TM-WORKERS -p udp -m multiport --dports 443,3478:3481,8801:8810,19302:19309 -j RETURN
-A TM-WORKERS -j DROP
COMMIT
RULES

ipt -C DOCKER-USER -i "$BR" -j TM-WORKERS 2>/dev/null || ipt -I DOCKER-USER -i "$BR" -j TM-WORKERS
ipt -C INPUT -i "$BR" -j DROP 2>/dev/null || ipt -I INPUT -i "$BR" -j DROP # nothing on the host itself

last=$(ipt -S TM-WORKERS | tail -n 1)
if [ "$last" != "-A TM-WORKERS -j DROP" ]; then
  echo "tm-worker-egress: the last rule of TM-WORKERS is not DROP: $last" >&2
  exit 1
fi
ipt -C DOCKER-USER -i "$BR" -j TM-WORKERS || { echo "tm-worker-egress: DOCKER-USER does not jump to TM-WORKERS" >&2; exit 1; }
ipt -C INPUT -i "$BR" -j DROP || { echo "tm-worker-egress: INPUT does not drop $BR" >&2; exit 1; }
