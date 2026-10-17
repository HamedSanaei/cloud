#!/usr/bin/env bash
# =============================================================================
# tofan-cloud deploy script
# Both release branches update the same production runtime. Images are built in CI.
# Rollback never downgrades data or restarts an incompatible financial authority.
#
# Usage:
#   deploy.sh <IMAGE> [<PUBLIC_URL>] [<SKIP_PUBLIC_HEALTHCHECK>]
#     IMAGE       Full web image reference, e.g. ghcr.io/hamedsanaei/cloud:sha-<sha>
#     PUBLIC_URL  Public base URL for the post-deploy check.
#                 (default: http://127.0.0.1:<port>)
#     SKIP_PUBLIC_HEALTHCHECK  Set to 1 ONLY for the initial bootstrap, before
#                 DNS/reverse-proxy/Cloudflare are configured. Default is "0"
#                 => public checks are REQUIRED and a failure triggers rollback.
#
# Reads env:
#   COMPOSE_DIR     deployment directory (default /opt/tofan/cloud)
#   CLOUD_PORT      localhost-only port   (default 8540)
#   API_IMAGE       backend image (api + worker), e.g.
#                   ghcr.io/hamedsanaei/cloud-api:sha-<sha>
#   GHCR_USERNAME   username for authenticated GHCR pull (private package)
#   GHCR_TOKEN      token with read:packages for that user (private package)
#
# Infrastructure/auth secrets and BACKUP_ENCRYPTION_KEY live in
# ${COMPOSE_DIR}/.env (NEVER in git). Provider credentials stay exclusively
# in the canonical platform's server-owned configuration.toml.
#
# GHCR access:
#   - Anonymous `docker pull` is attempted first -> works for PUBLIC packages.
#   - If that fails and GHCR_USERNAME+GHCR_TOKEN are provided, deploy.sh runs
#     `echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME"
#     --password-stdin` on the server, then retries the pull. The token is
#     never echoed and never written to the repository or the image.
# =============================================================================
set -Eeuo pipefail

PROJECT="tofan-cloud"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
CLOUD_PORT="${CLOUD_PORT:-8540}"
CONTAINER="$PROJECT"
API_CONTAINER="${PROJECT}-api"
WORKER_CONTAINER="${PROJECT}-worker"
PLATFORM_NETWORK="cloud-platform-production-bridge"
RELEASE_SHA="${RELEASE_SHA:?Set RELEASE_SHA to the approved full commit SHA}"
MIGRATION_STARTED=""
DB_HEAD_BEFORE=""
EXPECTED_DB_HEAD=""
CANDIDATE=""
GPG_HOME=""

CC_Y="\033[1;33m"; CC_G="\033[1;32m"; CC_R="\033[1;31m"; CC_C="\033[1;36m"; CC_N="\033[0m"
log()  { printf "${CC_C}[i]${CC_N} %s\n" "$*"; }
good() { printf "${CC_G}[ok]${CC_N} %s\n" "$*"; }
warn() { printf "${CC_Y}[! ]${CC_N} %s\n" "$*"; }
die()  { printf "${CC_R}[XX]${CC_N} %s\n" "$*" >&2; }

IMAGE="${1:?deploy.sh <IMAGE> [<PUBLIC_URL>] [<SKIP_PUBLIC_HEALTHCHECK>]}"
PUBLIC_URL="${2:-http://127.0.0.1:${CLOUD_PORT}}"
# SKIP_PUBLIC_HEALTHCHECK: 1 = bootstrap only; anything else = strict (default).
SKIP_PUBLIC=${3:-${SKIP_PUBLIC_HEALTHCHECK:-0}}

# Backend image (api + worker share one immutable image).
API_IMAGE="${API_IMAGE:-}"

# Registry credentials (used only when the package is private).
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

# --- global safety net ----------------------------------------------------
# Any command that fails between the pull and the final success marker triggers
# an automatic rollback to the previously deployed images (unless rollback
# already ran). Set up after argument parsing so usage errors stay clean.
ROLLED_BACK=""

on_err() {
  local rc=$? cmd="$BASH_COMMAND"
  if [[ -z "$ROLLED_BACK" && -n "${UPDATING:-}" ]]; then
    warn "Unexpected failure (${cmd}, rc=${rc}); attempting rollback via trap"
    if rollback "unexpected error: ${cmd}"; then
      exit 1
    fi
  fi
  exit "$rc"
}
trap on_err ERR

META="${COMPOSE_DIR}/deployed.version"
FINAL="${COMPOSE_DIR}/compose.yml"
HEALTH="http://127.0.0.1:${CLOUD_PORT}/healthz"
SPA="http://127.0.0.1:${CLOUD_PORT}/dashboard"
API_HEALTH="http://127.0.0.1:${CLOUD_PORT}/api/health/ready"
ENV_FILE="${COMPOSE_DIR}/.env"

cleanup() {
  [[ -z "$CANDIDATE" || ! -f "$CANDIDATE" ]] || rm -f -- "$CANDIDATE"
  if [[ -n "$GPG_HOME" ]]; then
    GNUPGHOME="$GPG_HOME" gpgconf --kill gpg-agent >/dev/null 2>&1 || true
    rm -rf -- "$GPG_HOME"
  fi
}
trap cleanup EXIT

compose() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$1" "${@:2}"
}

database_head() {
  local file="$1" exists
  exists="$(compose "$file" exec -T cloud-postgres psql -U cloud -d cloud -Atc \
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL")" || return 1
  if [[ "$exists" != t ]]; then printf 'base\n'; return; fi
  compose "$file" exec -T cloud-postgres psql -U cloud -d cloud -Atc \
    "SELECT COALESCE(max(created_at)::text, 'base') FROM drizzle.__drizzle_migrations"
}

backup_database() {
  local backup
  install -d -m 0700 "${COMPOSE_DIR}/backups"
  GPG_HOME="$(mktemp -d "${COMPOSE_DIR}/.gpg.XXXXXX")" || return 1
  chmod 0700 "$GPG_HOME"
  backup="${COMPOSE_DIR}/backups/pre-${RELEASE_SHA}-$(date -u +%Y%m%dT%H%M%S)-$$.dump.gpg"
  if ! compose "$CANDIDATE" exec -T cloud-postgres pg_dump -U cloud -d cloud -Fc |
    GNUPGHOME="$GPG_HOME" gpg --batch --yes --pinentry-mode loopback --no-symkey-cache \
      --symmetric --cipher-algo AES256 --compress-algo none --passphrase-fd 3 \
      --output "$backup" 3<<<"$BACKUP_ENCRYPTION_KEY"; then
    rm -f -- "$backup"
    die "Encrypted backup failed; migration was not started"
    return 1
  fi
  chmod 0600 "$backup"
  unset BACKUP_ENCRYPTION_KEY
  good "Encrypted pre-migration backup: $backup"
}

# ---------------------------------------------------------------------------
# Image pull with optional authenticated GHCR login (never echo the token).
# ---------------------------------------------------------------------------
pull_image() {
  local img="$1"
  if docker pull "$img" >/dev/null 2>&1; then
    return 0
  fi

  # Anonymous pull failed. If credentials are provided, log in and retry once.
  if [[ -z "$GHCR_USERNAME" || -z "$GHCR_TOKEN" ]]; then
    return 1
  fi

  log "anonymous pull failed; authenticating with GHCR (GHCR_USERNAME=${GHCR_USERNAME}) ..."
  if printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null 2>&1; then
    if docker pull "$img" >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Compose file for a given (web, api) image pair. Written atomically.
# Secrets are NOT inlined here — docker compose interpolates ${...} from the
# .env file next to this file (${COMPOSE_DIR}/.env).
# ---------------------------------------------------------------------------
write_compose() {
  local img="$1" api_img="$2" out="$3" tmp
  tmp="$(mktemp "${COMPOSE_DIR}/.compose.XXXXXX")"
  cat >"$tmp" <<YAML
name: ${PROJECT}
services:
  cloud:
    image: "${img}"
    container_name: ${CONTAINER}
    restart: unless-stopped
    depends_on:
      cloud-api:
        condition: service_healthy
    networks:
      - ${PROJECT}_net
    ports:
      - "127.0.0.1:${CLOUD_PORT}:80"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1/healthz"]
      interval: 20s
      timeout: 4s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID

  cloud-api:
    image: "${api_img}"
    container_name: ${API_CONTAINER}
    restart: unless-stopped
    depends_on:
      cloud-postgres:
        condition: service_healthy
      cloud-redis:
        condition: service_healthy
    networks:
      - ${PROJECT}_net
      - platform-bridge
    environment:
      NODE_ENV: production
      APP_ENV: production
      HOST: 0.0.0.0
      PORT: "8000"
      DATABASE_URL: \${DATABASE_URL:?DATABASE_URL must be set in ${COMPOSE_DIR}/.env}
      REDIS_URL: \${REDIS_URL:?REDIS_URL must be set in ${COMPOSE_DIR}/.env}
      AUTH_SECRET: \${AUTH_SECRET:?AUTH_SECRET must be set in ${COMPOSE_DIR}/.env}
      COOKIE_SECURE: \${COOKIE_SECURE:-true}
      CORS_ORIGIN: \${CORS_ORIGIN:-}
      PLATFORM_API_URL: \${PLATFORM_API_URL:?PLATFORM_API_URL must point to the canonical platform}
      FRONTEND_URL: \${FRONTEND_URL:?FRONTEND_URL must be configured}
      AUTH_DELIVERY_MODE: \${AUTH_DELIVERY_MODE:-live}
      SMTP_HOST: \${SMTP_HOST:-}
      SMTP_PORT: \${SMTP_PORT:-587}
      SMTP_SECURE: \${SMTP_SECURE:-false}
      SMTP_USER: \${SMTP_USER:-}
      SMTP_PASSWORD: \${SMTP_PASSWORD:-}
      SMTP_FROM: \${SMTP_FROM:-}
      PARSGREEN_SIGNATURE: \${PARSGREEN_SIGNATURE:-}
      PARSGREEN_FROM: \${PARSGREEN_FROM:-}
      PARSGREEN_ENDPOINT: \${PARSGREEN_ENDPOINT:-https://login.parsgreen.com/Api/SendSMS.asmx}
      GOOGLE_CLIENT_ID: \${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: \${GOOGLE_CLIENT_SECRET:-}
      GOOGLE_REDIRECT_URI: \${GOOGLE_REDIRECT_URI:-${PUBLIC_URL%/}/api/v1/auth/google/callback}
      LOG_LEVEL: \${LOG_LEVEL:-info}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 20s
      timeout: 5s
      retries: 4
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

  cloud-worker:
    image: "${api_img}"
    container_name: ${WORKER_CONTAINER}
    restart: unless-stopped
    depends_on:
      cloud-api:
        condition: service_healthy
      cloud-postgres:
        condition: service_healthy
      cloud-redis:
        condition: service_healthy
    networks:
      - ${PROJECT}_net
      - platform-bridge
    environment:
      NODE_ENV: production
      APP_ENV: production
      DATABASE_URL: \${DATABASE_URL:?DATABASE_URL must be set in ${COMPOSE_DIR}/.env}
      REDIS_URL: \${REDIS_URL:?REDIS_URL must be set in ${COMPOSE_DIR}/.env}
      AUTH_SECRET: \${AUTH_SECRET:?AUTH_SECRET must be set in ${COMPOSE_DIR}/.env}
      PLATFORM_API_URL: \${PLATFORM_API_URL:?PLATFORM_API_URL must point to the canonical platform}
      LOG_LEVEL: \${LOG_LEVEL:-info}
    command: ["npm", "run", "start:worker"]
    healthcheck:
      disable: true
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

  cloud-postgres:
    image: postgres:17-alpine
    container_name: ${PROJECT}-postgres
    restart: unless-stopped
    networks:
      - ${PROJECT}_net
    environment:
      POSTGRES_USER: cloud
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in ${COMPOSE_DIR}/.env}
      POSTGRES_DB: cloud
    volumes:
      - cloud-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cloud -d cloud"]
      interval: 10s
      timeout: 5s
      retries: 6
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]

  cloud-redis:
    image: redis:7-alpine
    container_name: ${PROJECT}-redis
    restart: unless-stopped
    networks:
      - ${PROJECT}_net
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "128mb", "--maxmemory-policy", "noeviction"]
    volumes:
      - cloud-redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "3"
        compress: "true"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]

volumes:
  cloud-postgres-data:
  cloud-redis-data:

networks:
  ${PROJECT}_net:
    name: ${PROJECT}_net
  platform-bridge:
    external: true
    name: ${PLATFORM_NETWORK}
YAML
  mv -f "$tmp" "$out"
}

meta_get() {
  local key="$1"
  [[ -f "$META" ]] || { printf ''; return; }
  grep -E "^${key}=" "$META" 2>/dev/null | tail -n1 | cut -d= -f2- || printf ''
}

meta_set() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp "${COMPOSE_DIR}/.meta.XXXXXX")"
  if [[ -f "$META" ]]; then
    grep -vE "^${key}=" "$META" >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv -f "$tmp" "$META"
}

current_healthy() {
  curl -fsS "$HEALTH" >/dev/null 2>&1
}

api_healthy() {
  curl -fsS "$API_HEALTH" >/dev/null 2>&1
}

wait_healthy() {
  local i=0 st
  for (( i=0; i<120; i++ )); do
    st="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo none)"
    [[ "$st" == "healthy" ]] && return 0
    [[ "$st" == "unhealthy" ]] && return 1
    sleep 1
  done
  return 1
}

wait_api_healthy() {
  local i=0 st
  for (( i=0; i<180; i++ )); do
    st="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$API_CONTAINER" 2>/dev/null || echo none)"
    [[ "$st" == "healthy" ]] && return 0
    [[ "$st" == "unhealthy" ]] && return 1
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# rollback <reason> — restores the previous (web, api) image pair, waits for
# health, verifies locally, restores metadata. Returns 0 on success.
# ---------------------------------------------------------------------------
rollback() {
  local reason="$1"
  ROLLED_BACK=1   # prevent the ERR trap from re-entering rollback
  warn "ROLLBACK triggered: ${reason}"
  if [[ -f "$FINAL" ]]; then
    compose "$FINAL" stop -t 30 cloud-api cloud-worker || {
      die "Cannot stop candidate writers; manual intervention required"; return 1;
    }
  fi
  if [[ -n "$MIGRATION_STARTED" && "$DB_HEAD_BEFORE" != "$EXPECTED_DB_HEAD" ]]; then
    die "Schema transition attempted. Writers remain stopped; restore the encrypted backup to an isolated database for operator recovery."
    return 1
  fi
  if [[ -z "${PREV_IMAGE}" || -z "${PREV_API_IMAGE}" ]]; then
    die "No previous image pair recorded — cannot roll back. Manual intervention required."
    return 1
  fi

  if ! docker image inspect "${PREV_IMAGE}" >/dev/null 2>&1 && ! pull_image "${PREV_IMAGE}"; then
    die "Could not pull previous web image ${PREV_IMAGE} during rollback."
    return 1
  fi
  if ! docker image inspect "${PREV_API_IMAGE}" >/dev/null 2>&1 && ! pull_image "${PREV_API_IMAGE}"; then
    die "Could not pull previous api image ${PREV_API_IMAGE} during rollback."
    return 1
  fi
  local previous_contract
  previous_contract="$(docker image inspect --format '{{index .Config.Labels "io.servercloud.platform-contract"}}' "$PREV_API_IMAGE")"
  if [[ "$previous_contract" != 1 ]]; then
    die "Previous image cannot prove canonical-wallet compatibility. Writers remain stopped."
    return 1
  fi

  write_compose "${PREV_IMAGE}" "${PREV_API_IMAGE}" "${FINAL}"
  if compose "$FINAL" up -d; then
    if wait_healthy && wait_api_healthy && current_healthy && api_healthy; then
      meta_set image "${PREV_IMAGE}"
      meta_set api_image "${PREV_API_IMAGE}"
      meta_set sha "${PREV_SHA}"
      good "Rollback successful — restored ${PREV_IMAGE} + ${PREV_API_IMAGE}"
      return 0
    else
      die "Previous images also failed to become healthy."
      return 1
    fi
  else
    die "Failed to start previous images during rollback."
    return 1
  fi
}

# --- preflight ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { die "docker not found on server"; exit 1; }
docker compose version >/dev/null 2>&1 || { die "docker compose v2 not available"; exit 1; }
mkdir -p "$COMPOSE_DIR"
command -v flock >/dev/null 2>&1 || { die "flock is required"; exit 1; }
command -v gpg >/dev/null 2>&1 || { die "gpg is required for encrypted migration backups"; exit 1; }
[[ -f "$ENV_FILE" ]] || { die "Missing server-owned .env"; exit 1; }
BACKUP_KEY_LINE="$(grep '^BACKUP_ENCRYPTION_KEY=' "$ENV_FILE" | tail -n 1 || true)"
BACKUP_ENCRYPTION_KEY="${BACKUP_KEY_LINE#*=}"
case "$BACKUP_ENCRYPTION_KEY" in
  \"*\"|\'*\') BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:1:${#BACKUP_ENCRYPTION_KEY}-2}" ;;
esac
unset BACKUP_KEY_LINE
[[ ${#BACKUP_ENCRYPTION_KEY} -ge 32 ]] || {
  die "BACKUP_ENCRYPTION_KEY must contain at least 32 characters; nothing was stopped"; exit 1;
}
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { die "RELEASE_SHA must be a full commit SHA"; exit 1; }
[[ "$CLOUD_PORT" =~ ^[0-9]+$ && "$CLOUD_PORT" -ge 1024 && "$CLOUD_PORT" -le 65535 ]] || { die "Invalid CLOUD_PORT"; exit 1; }
exec 9>"${COMPOSE_DIR}/.deployment.lock"
flock -n 9 || { die "Another deployment is running for this target"; exit 1; }
umask 077
exec 8>/var/lock/servercloud-platform-release.lock || {
  die "Cannot open the shared website/platform release lock"; exit 1;
}
flock -w 600 8 || {
  die "Another website/platform release is still active; retry the current SHA"; exit 1;
}
existing_projects="$(docker ps -a \
  --filter "label=com.docker.compose.project.working_dir=${COMPOSE_DIR}" \
  --format '{{.Label "com.docker.compose.project"}}')"
while IFS= read -r existing_project; do
  if [[ -n "$existing_project" && "$existing_project" != "$PROJECT" ]]; then
    die "Deployment path belongs to another environment/project; nothing was stopped"; exit 1
  fi
done <<< "$existing_projects"

# Backend image is required for the full topology.
if [[ -z "$API_IMAGE" ]]; then
  die "API_IMAGE env is required (backend image, e.g. ghcr.io/hamedsanaei/cloud-api:sha-<sha>)"
  exit 1
fi

PREV_IMAGE="$(meta_get image)"
PREV_API_IMAGE="$(meta_get api_image)"
PREV_SHA="$(meta_get sha)"
log "deploy dir    : ${COMPOSE_DIR}"
log "image (new)   : ${IMAGE}"
log "api   (new)   : ${API_IMAGE}"
log "public check  : ${PUBLIC_URL}"
log "skip public hc: ${SKIP_PUBLIC}  (1=initial bootstrap only)"
log "ghcr access   : $([ -n "$GHCR_USERNAME" ] && echo authenticated || echo anonymous)"
log "previous web  : ${PREV_IMAGE:-<none>}"
log "previous api  : ${PREV_API_IMAGE:-<none>}"

# --- pull new images -----------------------------------------------------------
good "validating + pulling web image ${IMAGE} ..."
if ! pull_image "${IMAGE}"; then
  die "Failed to pull ${IMAGE}. Nothing changed; aborting."
  exit 1
fi
good "validating + pulling api image ${API_IMAGE} ..."
if ! pull_image "${API_IMAGE}"; then
  die "Failed to pull ${API_IMAGE}. Nothing changed; aborting."
  exit 1
fi

for candidate_image in "$IMAGE" "$API_IMAGE"; do
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_image")"
  contract="$(docker image inspect --format '{{index .Config.Labels "io.servercloud.platform-contract"}}' "$candidate_image")"
  [[ "$revision" == "$RELEASE_SHA" && "$contract" == 1 ]] || {
    die "Image revision/contract does not match the approved release"; exit 1;
  }
done
EXPECTED_DB_HEAD="$(docker run --rm "$API_IMAGE" node --input-type=module -e \
  "import {readFileSync} from 'node:fs'; console.log(JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8')).entries.at(-1).when)")"
[[ "$EXPECTED_DB_HEAD" =~ ^[0-9]+$ ]] || { die "Image has no valid migration head"; exit 1; }
CANDIDATE="${COMPOSE_DIR}/.compose.${RELEASE_SHA}.$$.candidate.yml"
write_compose "$IMAGE" "$API_IMAGE" "$CANDIDATE"
compose "$CANDIDATE" config --quiet
docker network inspect "$PLATFORM_NETWORK" >/dev/null || {
  die "Deploy the matching canonical platform environment first"; exit 1;
}
# No DB mutation: fail before draining writers if the canonical API is absent,
# financially incompatible, insecure, or belongs to another environment.
compose "$CANDIDATE" run --rm --no-deps cloud-api node --input-type=module -e '
  import {loadConfig} from "./dist/config.js";
  import {assertPlatformCompatibility} from "./dist/modules/integration/platform.js";
  const c = loadConfig();
  if (!c.PLATFORM_API_URL) throw new Error("Unified deployment requires PLATFORM_API_URL");
  if (c.AUTH_DELIVERY_MODE !== "live") throw new Error("Live authentication delivery is required");
  await assertPlatformCompatibility();
'
compose "$CANDIDATE" up -d --wait cloud-postgres cloud-redis
DB_HEAD_BEFORE="$(database_head "$CANDIDATE")"
if [[ "$DB_HEAD_BEFORE" != base && ( ! "$DB_HEAD_BEFORE" =~ ^[0-9]+$ || "$DB_HEAD_BEFORE" -gt "$EXPECTED_DB_HEAD" ) ]]; then
  die "Database is newer than the candidate; refusing an application/schema downgrade"; exit 1
fi
UPDATING=1
if [[ -f "$FINAL" ]]; then compose "$FINAL" stop -t 30 cloud-api cloud-worker; fi
backup_database
MIGRATION_STARTED=1
compose "$CANDIDATE" run --rm --no-deps cloud-api node dist/db/migrate.js
[[ "$(database_head "$CANDIDATE")" == "$EXPECTED_DB_HEAD" ]] || {
  rollback "Migration head does not match the candidate image" || exit 1; exit 2;
}
mv -f "$CANDIDATE" "$FINAL"
if ! compose "$FINAL" up -d; then
  rollback "docker compose up failed for ${IMAGE} + ${API_IMAGE}" || exit 1
  exit 2
fi

# --- health + local verification ------------------------------------------------
if ! wait_healthy; then
  rollback "healthcheck failed for web ${IMAGE}" || exit 1
  exit 2
fi
good "web container healthy"

if ! wait_api_healthy; then
  rollback "healthcheck failed for api ${API_IMAGE}" || exit 1
  exit 2
fi
good "api container healthy"

if current_healthy; then
  good "local /healthz OK -> ${HEALTH}"
else
  rollback "local /healthz failed for ${IMAGE}" || exit 1
  exit 2
fi

if api_healthy; then
  good "local api readiness OK -> ${API_HEALTH}"
else
  rollback "local api /api/health/ready failed for ${API_IMAGE}" || exit 1
  exit 2
fi

if curl -fsS -o /dev/null "$SPA"; then
  good "local SPA route OK -> ${SPA}"
else
  rollback "local SPA route /dashboard failed for ${IMAGE}" || exit 1
  exit 2
fi

# In unified mode the web worker intentionally does not run a second billing
# authority. Its process must nevertheless stay alive without restart churn.
worker_restarts="$(docker inspect --format '{{.RestartCount}}' "$WORKER_CONTAINER")"
sleep 5
if [[ "$(docker inspect --format '{{.State.Running}}:{{.RestartCount}}' "$WORKER_CONTAINER")" != "true:${worker_restarts}" ]]; then
  rollback "Unified web worker is not stable" || exit 1
  exit 2
fi

# --- public verification --------------------------------------------------------
# STRICT by default (SKIP_PUBLIC != 1). A failed public check marks this deploy
# failed and rolls back. Public checks are ONLY skipped for the initial
# bootstrap via SKIP_PUBLIC=1, because DNS/CF/reverse-proxy may not exist yet.
if [[ "$PUBLIC_URL" == http://127.0.0.1* ]]; then
  warn "public URL omitted/loopback — skipping public verification"
elif [[ "$SKIP_PUBLIC" == "1" ]]; then
  warn "SKIP_PUBLIC_HEALTHCHECK=1 (initial bootstrap) — public verification skipped"
  warn "Container is verified healthy & serving locally. Re-run a strict deploy"
  warn "once Cloudflare/DNS/ingress are live to confirm the public path."
else
  log "public verification is STRICT for this deployment ..."
  if curl -fsSL -o /dev/null "$PUBLIC_URL/healthz"; then
    good "public /healthz OK -> ${PUBLIC_URL}/healthz"
  else
    warn "public /healthz FAILED -> rollback"
    rollback "public /healthz failed at ${PUBLIC_URL}/healthz" || exit 1
    exit 2
  fi
  if curl -fsSL -o /dev/null "$PUBLIC_URL/dashboard"; then
    good "public /dashboard OK -> ${PUBLIC_URL}/dashboard"
  else
    warn "public /dashboard FAILED -> rollback"
    rollback "public /dashboard failed at ${PUBLIC_URL}/dashboard" || exit 1
    exit 2
  fi
fi

# --- success ---------------------------------------------------------------------
meta_set image "$IMAGE"
meta_set api_image "$API_IMAGE"
meta_set sha "$RELEASE_SHA"
meta_set deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
meta_set public_url "$PUBLIC_URL"
meta_set environment production
meta_set platform_contract 1
meta_set database_head "$EXPECTED_DB_HEAD"

good "DEPLOYMENT SUCCEEDED"
printf "%-32s : %s\n" "Commit SHA" "$RELEASE_SHA"
printf "%-32s : %s\n" "Web image" "$IMAGE"
printf "%-32s : %s\n" "API image" "$API_IMAGE"
printf "%-32s : %s\n" "Web container" "$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
printf "%-32s : %s\n" "API container" "$(docker inspect --format='{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || echo unknown)"
printf "%-32s : %s\n" "Health-check result" "$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)"
printf "%-32s : %s\n" "Local health URL" "$HEALTH"
printf "%-32s : %s\n" "Local api URL" "$API_HEALTH"
printf "%-32s : %s\n" "SPA URL" "$SPA"
printf "%-32s : %s\n" "Public URL" "$PUBLIC_URL"
printf "%-32s : %s\n" "Deployment dir/host" "${COMPOSE_DIR} (${CONTAINER})"