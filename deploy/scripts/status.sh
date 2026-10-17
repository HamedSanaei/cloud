#!/usr/bin/env bash
# Read-only status on the explicitly selected target; failure exits nonzero.
set -Eeuo pipefail

PROJECT=tofan-cloud
COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
CLOUD_PORT="${CLOUD_PORT:-8540}"
META="${COMPOSE_DIR}/deployed.version"
failed=0

printf '== shared production container status ==\n'
docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}' || failed=1

printf '\n== last healthy release metadata ==\n'
if [[ -f "$META" ]]; then cat "$META"; else printf 'No successful release recorded\n'; failed=1; fi
sha="$(awk -F= '$1=="sha" {print $2}' "$META" 2>/dev/null || true)"
for container in "$PROJECT" "${PROJECT}-api" "${PROJECT}-worker"; do
  state="$(docker inspect --format '{{.State.Running}}:{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container" 2>/dev/null || true)"
  printf '%s: %s\n' "$container" "${state:-missing}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "$state" == "true:${sha}" ]] || failed=1
done

printf '\n== readiness and HTTP smoke ==\n'
for endpoint in healthz api/health/ready dashboard; do
  if curl --fail --silent --show-error --max-time 10 --output /dev/null "http://127.0.0.1:${CLOUD_PORT}/${endpoint}"; then
    printf '%s OK\n' "$endpoint"
  else
    printf '%s FAILED\n' "$endpoint" >&2
    failed=1
  fi
done
exit "$failed"
