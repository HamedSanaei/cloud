#!/usr/bin/env bash
# tofan-cloud status — quick health + version summary on the production server.
# Usage: sudo bash status.sh   (or run as a user with access to /opt/tofan/cloud + docker)
set -Eeuo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
CLOUD_PORT="${CLOUD_PORT:-8540}"
CONTAINER="tofan-cloud"
FINAL="${COMPOSE_DIR}/compose.yml"
META="${COMPOSE_DIR}/deployed.version"

echo "== container status =="
docker ps -a --filter "name=${CONTAINER}" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null || echo "(container not found)"

echo
echo "== image tag (from compose) =="
grep -E '^\s+image:' "${FINAL}" 2>/dev/null | tr -d ' ' || echo "(no compose.yml yet)"

echo
echo "== deployed.version metadata =="
cat "${META}" 2>/dev/null || echo "(no metadata yet)"

echo
echo "== local endpoint checks =="
curl -fsS -m 3 "http://127.0.0.1:${CLOUD_PORT}/healthz" 2>/dev/null && echo " <- /healthz OK" || echo "/healthz FAILED"
curl -fsS -o /dev/null -m 3 -w "HTTP %{http_code}\n" "http://127.0.0.1:${CLOUD_PORT}/dashboard" 2>/dev/null || echo "/dashboard FAILED"