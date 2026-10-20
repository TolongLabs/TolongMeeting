#!/bin/sh
# Probes the worker network's egress rules from inside it: ./check-egress.sh <public host>, e.g. tm.example.
# Needs Docker and the tm-workers network (docker compose up creates it). Prints ok or FAIL per probe and exits 1 if any
# probe fails. A reachable probe must exit 0 from curl; a dropped one must time out (28): a refusal (7) means the
# packet was not dropped.
set -u
[ $# -eq 1 ] || { echo "usage: $0 <public host>" >&2; exit 2; }
HOST=$1
CADDY=172.30.0.2
failed=0

probe() { # probe <want: 0 or 28> <url>
  want=$1
  url=$2
  # The worker's own DNS, extra host and sysctl (see packages/scheduler/src/container-spec.ts).
  docker run --rm --network tm-workers --dns 1.1.1.1 --dns 8.8.8.8 --add-host "$HOST:$CADDY" \
    --sysctl net.ipv6.conf.all.disable_ipv6=1 curlimages/curl:8.11.1 \
    -s -o /dev/null --connect-timeout 5 --max-time 8 "$url" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then echo "ok    $url (curl exit $got)"; else echo "FAIL  $url (curl exit $got, wanted $want)"; failed=1; fi
}

probe 0 https://example.com/
probe 0 "https://$HOST/api/health"
probe 28 http://169.254.169.254/
probe 28 http://100.100.100.200/
probe 28 http://10.0.0.1/
probe 28 http://192.168.0.1/
probe 28 http://172.30.0.1:22/ # the host
probe 28 "http://$CADDY:80/"
probe 28 http://example.com/ # port 80

# Other containers: a second worker, the app network's gateway (the host side of the app network) and the Docker proxy.
# A dropped probe times out (28); a refusal (7) would mean the packet arrived.
victim=$(docker run -d --rm --network tm-workers --entrypoint sleep curlimages/curl:8.11.1 60) || { echo "FAIL  cannot start a second worker-network container"; exit 1; }
trap 'docker rm -f "$victim" >/dev/null 2>&1' EXIT
ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1" 2>/dev/null; }
gateway_of() { docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$1" 2>/dev/null; }

target() { # target <label> <address> <url suffix>
  if [ -n "$2" ]; then probe 28 "http://$2$3"; else echo "FAIL  no address for $1"; failed=1; fi
}
target "worker to worker" "$(ip_of "$victim" tm-workers)" ":6080/"
target "app network gateway" "$(gateway_of tolongmeeting_app)" ":3000/"
proxy=$(docker ps -q --filter label=com.docker.compose.service=docker-proxy | head -n 1)
target "docker-proxy" "$([ -n "$proxy" ] && ip_of "$proxy" tolongmeeting_gate)" ":2375/"

exit "$failed"
