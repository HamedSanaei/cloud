#!/usr/bin/env bash
# Opt-in disposable DinD drill. No host daemon restart, published ports or mounts.
# Prerequisites: Bash, systemd-analyze, local Docker, privileged containers, image access.
# Usage: DRILL_ALLOW_DIND=1 bash deploy/tests/runtime-recovery-drill.sh
set -Eeuo pipefail
[[ "${DRILL_ALLOW_DIND:-}" == 1 ]] || {
  echo 'Set DRILL_ALLOW_DIND=1 to create/remove a disposable privileged DinD fixture.' >&2
  exit 1
}
command -v systemd-analyze >/dev/null || { echo 'systemd-analyze is required' >&2; exit 1; }
# Refuse SSH/TCP/remote contexts. Only a local Unix socket or Windows named pipe
# may create the fixture; the recovery commands themselves use its nested daemon.
endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
case "$endpoint" in
  unix:///*|npipe://*) ;;
  *) echo 'Recovery drill requires a local Docker endpoint, not a remote context.' >&2; exit 1 ;;
esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="servercloud-recovery-drill-$(date +%s)-$$"
label="servercloud.recovery-drill=$fixture"
created=0
unit_directory="$(mktemp -d)"
cleanup() {
  if (( created )); then
    # Remove only the exact fixture created above, never any pre-existing object.
    if [[ "$(docker inspect --format '{{index .Config.Labels "servercloud.recovery-drill"}}' "$fixture" 2>/dev/null || true)" == "$fixture" ]]; then
      docker rm -f -v "$fixture" >/dev/null
    fi
  fi
  rm -rf -- "$unit_directory"
}
trap cleanup EXIT
wait_daemon() {
  local attempt
  for (( attempt=0; attempt<90; attempt++ )); do
    if docker exec "$fixture" docker info >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo 'Dedicated DinD daemon failed to become ready.' >&2
  docker logs "$fixture" >&2
  return 1
}
docker run -d --privileged --name "$fixture" --label "$label" \
  -e DOCKER_TLS_CERTDIR= docker:29-dind >/dev/null
created=1
wait_daemon
docker exec "$fixture" apk add --no-cache bash python3 util-linux >/dev/null
docker exec "$fixture" mkdir -p /fixture/scripts /opt/tofan/cloud
docker cp "$root/scripts/reconcile-runtime.sh" "$fixture:/fixture/scripts/reconcile-runtime.sh"
docker cp "$root/scripts/runtime-reconcile.py" "$fixture:/fixture/scripts/runtime-reconcile.py"
docker cp "$root/scripts/deploy.sh" "$fixture:/fixture/scripts/deploy.sh"
docker cp "$root/scripts/server-bootstrap.sh" "$fixture:/fixture/scripts/server-bootstrap.sh"
docker cp "$root/tests/runtime-recovery-dind.sh" "$fixture:/fixture/drill.sh"
# Reuse public fixture images if already cached locally (no registry credentials
# or host filesystem data enter the dedicated daemon).
if docker image inspect postgres:17-alpine redis:7-alpine >/dev/null 2>&1; then
  docker save postgres:17-alpine redis:7-alpine | docker exec -i "$fixture" docker load >/dev/null
fi
docker exec "$fixture" bash /fixture/drill.sh initialize
docker cp "$fixture:/etc/systemd/system/tofan-cloud-reconcile.service" "$unit_directory/tofan-cloud-reconcile.service"
# Verify the generated unit without loading/starting it in the host manager.
systemd-analyze verify "$unit_directory/tofan-cloud-reconcile.service"
# Restart only the dedicated fixture container/daemon, never the host daemon.
docker restart -t 30 "$fixture" >/dev/null
wait_daemon
docker exec "$fixture" bash /fixture/drill.sh recover
# The second dedicated restart proves restart=always survives clean shutdown.
docker restart -t 30 "$fixture" >/dev/null
wait_daemon
docker exec "$fixture" bash /fixture/drill.sh verify-restart
printf 'Isolated Docker recovery drill passed (fixture %s).\n' "$fixture"
