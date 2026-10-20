# The home-route sidecar: a Tailscale node that sends a server-run worker's traffic out through the member's home device
# (plan 08 Task 13). The worker joins this container's network namespace and shares nothing else with it.
# Build from the repository root with `docker compose -f docker/compose.yaml --env-file docker/worker/versions.env \
#   --env-file .env --profile build build home-route`. It is tagged tm-home-route:<TAILSCALE_VERSION>, the only image the
# Docker gate accepts for a sidecar. UNVERIFIED: not built yet (root filesystem full); smoke test at acceptance Step 8.
ARG TAILSCALE_VERSION
FROM tailscale/tailscale:v${TAILSCALE_VERSION}
# jq reads `tailscale status --json`. iptables and its restore tools come with the Tailscale image.
RUN apk add --no-cache jq
COPY --chmod=0755 docker/egress/deny-private.sh /usr/local/bin/deny-private.sh
COPY --chmod=0755 docker/home-route/exit-node.sh /usr/local/bin/exit-node.sh
COPY --chmod=0755 docker/home-route/start.sh /usr/local/bin/start.sh
ENTRYPOINT ["/usr/local/bin/start.sh"]
