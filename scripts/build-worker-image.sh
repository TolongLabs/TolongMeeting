#!/bin/sh
set -eu
docker build $(grep -v '^#' docker/worker/versions.env | sed 's/^/--build-arg=/') -f docker/worker/Dockerfile -t tm-worker:dev -t tolongmeeting/worker:current .
