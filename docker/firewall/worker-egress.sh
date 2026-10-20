#!/bin/sh
# Egress rules for the tm-workers network: bridge tm-workers0, 172.30.0.0/24, Caddy at 172.30.0.2.
# Run as root at boot, after Docker (tm-worker-egress.service). Safe to run again: it rebuilds its own chain and adds
# its two hooks only when they are missing. Install: copy to /usr/local/sbin/tm-worker-egress.sh (mode 755).
set -eu
BR=tm-workers0
CADDY=172.30.0.2
# -w waits for the xtables lock, which Docker also takes while it starts containers.
ipt() { iptables -w "$@"; }

ipt -N TM-WORKERS 2>/dev/null || ipt -F TM-WORKERS
ipt -C DOCKER-USER -i "$BR" -j TM-WORKERS 2>/dev/null || ipt -I DOCKER-USER -i "$BR" -j TM-WORKERS
ipt -C INPUT -i "$BR" -j DROP 2>/dev/null || ipt -I INPUT -i "$BR" -j DROP # nothing on the host itself
ipt -A TM-WORKERS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ipt -A TM-WORKERS -s "$CADDY" -p tcp --dport 6080 -j ACCEPT # Caddy to a worker's noVNC
ipt -A TM-WORKERS -d "$CADDY" -p tcp --dport 443 -j ACCEPT # workers to the app API and ntfy
ipt -A TM-WORKERS -d 1.1.1.1,8.8.8.8 -p udp --dport 53 -j RETURN
ipt -A TM-WORKERS -d 1.1.1.1,8.8.8.8 -p tcp --dport 53 -j RETURN
# Private ranges (other containers included), link-local and cloud metadata. 100.64.0.0/10 covers metadata services such
# as Alibaba Cloud's 100.100.100.200.
ipt -A TM-WORKERS -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10 -j DROP
ipt -A TM-WORKERS -p tcp -m multiport --dports 443,8801:8810 -j RETURN # HTTPS, Zoom media over TCP
ipt -A TM-WORKERS -p udp -m multiport --dports 443,3478:3481,8801:8810,19302:19309 -j RETURN # QUIC, TURN, Zoom, Meet
ipt -A TM-WORKERS -j DROP
