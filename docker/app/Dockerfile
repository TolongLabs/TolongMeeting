# The website, the scheduler, the export runner and the Docker gate. Build from the repository root through docker/compose.yaml:
#   docker compose -f docker/compose.yaml --env-file .env build
# One install serves every target. The tree is owned by `bun` (uid 1000 and gid 1000, the worker's uid), which the
# website and the scheduler run as; the scheduler must share the uid with the files it writes for workers.
FROM oven/bun:1.4.3 AS base
WORKDIR /app
RUN chown bun:bun /app
USER bun
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile && rm -rf "$HOME/.bun/install/cache"

# --- web: the Next.js website and API (no secrets are needed to build it) ---
FROM base AS web
RUN bun run --cwd packages/web build
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["bun", "--bun", "--cwd", "packages/web", "next", "start", "-p", "3000"]

# --- scheduler: pg-boss jobs, launcher, monitor, retention, backups ---
# pg_dump (the major version must not be older than the server's, postgres:17), rclone (backups) and ffmpeg (the
# MP4 remux of a meeting that ends without the pipeline).
FROM base AS scheduler
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg postgresql-client-17 rclone \
 && rm -rf /var/lib/apt/lists/*
USER bun
CMD ["bun", "run", "packages/scheduler/src/main.ts"]

# --- exports: the export runner (zip, PDF, GitHub, Google Docs, Notion) ---
# No extra packages: the PDF and image libraries are Bun dependencies, and the runner starts no other program.
FROM base AS exports
CMD ["bun", "run", "packages/exports/src/main.ts"]

# --- gate: the one process that talks to the Docker socket ---
# Runs as root only to open /var/run/docker.sock; Compose drops every capability and makes the file system read-only.
FROM base AS gate
USER root
CMD ["bun", "run", "packages/scheduler/src/docker-gate/main.ts"]
