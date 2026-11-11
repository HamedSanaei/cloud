#!/usr/bin/env bash
# Internal fixture payload: invoked only inside runtime-recovery-drill.sh's DinD.
set -Eeuo pipefail
export COMPOSE_DIR=/opt/tofan/cloud
export RECONCILE_TIMEOUT_SECONDS=90
reconcile() { bash /fixture/scripts/reconcile-runtime.sh "$@"; }
expect_failure() {
  if "$@"; then echo "Expected refusal: $*" >&2; exit 1; fi
}
wait_ready() {
  local attempt
  for (( attempt=0; attempt<90; attempt++ )); do
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' tofan-cloud-postgres)" == healthy &&
          "$(docker inspect --format '{{.State.Health.Status}}' tofan-cloud-redis)" == healthy ]]; then return 0; fi
    sleep 1
  done
  echo 'Fixture services failed to become healthy.' >&2
  return 1
}
# A newly initialized PostgreSQL image can report healthy briefly before the
# entrypoint's final server restart. Probe SQL readiness across several polls
# before issuing the fixture's first write.
wait_sql_ready() {
  local attempt consecutive=0
  for (( attempt=0; attempt<90; attempt++ )); do
    if [[ "$(docker exec tofan-cloud-postgres psql -U cloud -d cloud -Atqc 'SELECT 1' 2>/dev/null || true)" == 1 ]]; then
      consecutive=$((consecutive + 1))
      if (( consecutive >= 3 )); then return 0; fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo 'Disposable PostgreSQL fixture never reached stable SQL readiness.' >&2
  return 1
}
assert_preserved() {
  python3 - <<'PY'
import json
import subprocess
from pathlib import Path
saved = json.loads(Path('/fixture/identities.json').read_text())
for kind, names in saved.items():
    for name, original in names.items():
        command = ['docker'] + (['volume'] if kind == 'volumes' else []) + ['inspect', name]
        actual = json.loads(subprocess.check_output(command))[0]
        fields = ('Name', 'Mountpoint', 'Labels') if kind == 'volumes' else ('Id', 'Mounts', 'Config')
        for field in fields:
            assert actual[field] == original[field], (kind, name, field)
PY
  [[ "$(docker exec tofan-cloud-postgres psql -U cloud -d cloud -Atc 'SELECT marker FROM recovery_drill')" == durable-postgres-marker ]]
  [[ "$(docker exec tofan-cloud-redis redis-cli GET recovery-drill)" == durable-redis-marker ]]
}
deployment_preflight_boundaries() {
  # Run the real deploy entrypoint as root only inside this disposable daemon.
  # The shim hides Redis for one case and records commands; recovery still uses
  # real inspect/cp data for PostgreSQL, and inherits the actual deploy fd9 lock.
  local real_docker mode
  real_docker="$(command -v docker)"
  mkdir -p /fixture/deploy-bin /var/lock
  cat >/fixture/deploy-bin/docker <<'PY'
#!/usr/bin/python3
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
with Path('/fixture/deploy-commands.jsonl').open('a') as stream:
    stream.write(json.dumps(args) + '\n')
if args == ['compose', 'version']:
    print('Docker Compose version fixture')
    sys.exit(0)
if os.environ.get('DRILL_ABSENT_REDIS') == '1' and args == ['inspect', 'tofan-cloud-redis']:
    sys.exit(1)
os.execv(os.environ['REAL_DOCKER'], [os.environ['REAL_DOCKER'], *args])
PY
  cat >/fixture/deploy-bin/gpg <<'SH'
#!/usr/bin/env sh
echo 'Unexpected backup invocation before failed preflight' >&2
exit 97
SH
  chmod +x /fixture/deploy-bin/docker /fixture/deploy-bin/gpg
  printf 'BACKUP_ENCRYPTION_KEY=%064d\n' 1 >"$COMPOSE_DIR/.env"
  chmod 600 "$COMPOSE_DIR/.env"
  printf 'previous-deployment-metadata\n' >"$COMPOSE_DIR/deployed.version"
  for mode in absent maintenance; do
    : >/fixture/deploy-commands.jsonl
    if [[ "$mode" == maintenance ]]; then touch "$COMPOSE_DIR/.maintenance"; fi
    expect_failure env PATH="/fixture/deploy-bin:$PATH" REAL_DOCKER="$real_docker" \
      DRILL_ABSENT_REDIS="$([[ "$mode" == absent ]] && echo 1 || echo 0)" \
      RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
      API_IMAGE=fixture.invalid/cloud-api:disposable \
      bash /fixture/scripts/deploy.sh fixture.invalid/cloud:disposable
    [[ "$(cat "$COMPOSE_DIR/deployed.version")" == previous-deployment-metadata ]]
    DRILL_EXPECT_MODE="$mode" python3 - <<'PY'
import json
import os
from pathlib import Path
calls = [json.loads(line) for line in Path('/fixture/deploy-commands.jsonl').read_text().splitlines()]
assert ['compose', 'version'] in calls
if os.environ['DRILL_EXPECT_MODE'] == 'absent':
    assert ['inspect', 'tofan-cloud-redis'] in calls, calls
else:
    assert all(call[0] in ('compose', 'ps') for call in calls), calls
for call in calls:
    assert call[0] in ('compose', 'ps', 'inspect', 'volume', 'cp'), call
    if call[0] == 'compose':
        assert call == ['compose', 'version'], call
PY
    if [[ "$mode" == maintenance ]]; then rm "$COMPOSE_DIR/.maintenance"; fi
  done
}
bootstrap_boundaries() {
  mkdir -p /fixture/bootstrap-bin /etc/systemd/system
  cat >/fixture/bootstrap-bin/systemctl <<'SH'
#!/usr/bin/env sh
printf '%s\n' "$*" >>/fixture/systemctl-calls
case "$*" in
  daemon-reload|'enable tofan-cloud-reconcile.service') exit 0 ;;
  *) echo 'Bootstrap attempted a live service operation' >&2; exit 98 ;;
esac
SH
  for dependency in openssl gpg curl; do
    printf '#!/bin/sh\nexit 99\n' >"/fixture/bootstrap-bin/$dependency"
    chmod +x "/fixture/bootstrap-bin/$dependency"
  done
  chmod +x /fixture/bootstrap-bin/systemctl
  cp "$COMPOSE_DIR/.env" /fixture/env-before
  cp "$COMPOSE_DIR/deployed.version" /fixture/metadata-before
  PATH="/fixture/bootstrap-bin:$PATH" bash /fixture/scripts/server-bootstrap.sh --recovery-only
  cmp /fixture/env-before "$COMPOSE_DIR/.env"
  cmp /fixture/metadata-before "$COMPOSE_DIR/deployed.version"
  # Exercise the actual installed bundle, not an assumed copy.
  expect_failure bash "$COMPOSE_DIR/scripts/reconcile-runtime.sh" --check
  [[ "$(cat /fixture/systemctl-calls)" == $'daemon-reload\nenable tofan-cloud-reconcile.service' ]]
}

case "${1:?fixture phase required}" in
  initialize)
    docker image inspect postgres:17-alpine >/dev/null 2>&1 || docker pull postgres:17-alpine >/dev/null
    docker image inspect redis:7-alpine >/dev/null 2>&1 || docker pull redis:7-alpine >/dev/null
    for service in cloud-postgres cloud-redis; do
      docker volume create --label com.docker.compose.project=tofan-cloud \
        --label "com.docker.compose.volume=$service-data" "tofan-cloud_$service-data" >/dev/null
    done
    docker run -d --name tofan-cloud-postgres --restart=no \
      --label com.docker.compose.project=tofan-cloud \
      --label com.docker.compose.service=cloud-postgres \
      --label com.docker.compose.project.working_dir="$COMPOSE_DIR" \
      -e POSTGRES_USER=cloud -e POSTGRES_DB=cloud -e POSTGRES_PASSWORD=disposable-fixture-password \
      --health-cmd='pg_isready -U cloud -d cloud' --health-interval=1s --health-timeout=3s --health-retries=60 \
      -v tofan-cloud_cloud-postgres-data:/var/lib/postgresql/data postgres:17-alpine >/dev/null
    docker run -d --name tofan-cloud-redis --restart=no \
      --label com.docker.compose.project=tofan-cloud \
      --label com.docker.compose.service=cloud-redis \
      --label com.docker.compose.project.working_dir="$COMPOSE_DIR" \
      --health-cmd='redis-cli ping' --health-interval=1s --health-timeout=3s --health-retries=60 \
      -v tofan-cloud_cloud-redis-data:/data redis:7-alpine redis-server --appendonly yes >/dev/null
    wait_ready
    wait_sql_ready
    docker exec tofan-cloud-postgres psql -U cloud -d cloud -v ON_ERROR_STOP=1 -c \
      "CREATE TABLE recovery_drill (marker text NOT NULL); INSERT INTO recovery_drill VALUES ('durable-postgres-marker');" >/dev/null
    docker exec tofan-cloud-redis redis-cli SET recovery-drill durable-redis-marker >/dev/null
    docker exec tofan-cloud-redis redis-cli SAVE >/dev/null
    python3 - <<'PY'
import json
from pathlib import Path
import subprocess
saved = {}
for kind, names in [('containers', ['tofan-cloud-postgres', 'tofan-cloud-redis']),
                    ('volumes', ['tofan-cloud_cloud-postgres-data', 'tofan-cloud_cloud-redis-data'])]:
    saved[kind] = {}
    for name in names:
        command = ['docker'] + (['volume'] if kind == 'volumes' else []) + ['inspect', name]
        saved[kind][name] = json.loads(subprocess.check_output(command))[0]
Path('/fixture/identities.json').write_text(json.dumps(saved))
PY
    # Reproduce the incident policy; strict checks must not repair it.
    expect_failure reconcile --check
    [[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' tofan-cloud-postgres)" == no ]]
    deployment_preflight_boundaries
    bootstrap_boundaries
    assert_preserved
    ;;
  recover)
    # Policy no leaves both containers stopped after the dedicated daemon restart.
    [[ "$(docker inspect --format '{{.State.Running}}' tofan-cloud-postgres)" == false ]]
    [[ "$(docker inspect --format '{{.State.Running}}' tofan-cloud-redis)" == false ]]
    touch "$COMPOSE_DIR/.maintenance"
    reconcile
    expect_failure reconcile --require-active
    expect_failure reconcile --check
    [[ "$(docker inspect --format '{{.State.Running}}' tofan-cloud-postgres)" == false ]]
    rm "$COMPOSE_DIR/.maintenance"
    reconcile --require-active
    reconcile --check
    assert_preserved
    # Explicit manual stop of always-policy services must also be recoverable.
    docker stop tofan-cloud-postgres tofan-cloud-redis >/dev/null
    expect_failure reconcile --check
    reconcile --require-active
    reconcile --check
    assert_preserved
    ;;
  verify-restart)
    # Strict read-only check proves the corrected policy restarted both services;
    # recovery is intentionally not called before checking their running states.
    [[ "$(docker inspect --format '{{.State.Running}}' tofan-cloud-postgres)" == true ]]
    [[ "$(docker inspect --format '{{.State.Running}}' tofan-cloud-redis)" == true ]]
    wait_ready
    reconcile --check --require-active
    assert_preserved
    ;;
  *) echo 'Unknown dedicated daemon drill phase.' >&2; exit 1 ;;
esac
