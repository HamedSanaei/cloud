#!/usr/bin/env bash
# =============================================================================
# tofan-cloud deploy script
# Runs ON the production server. Idempotent, immutable, with automatic
# rollback on any failure. Driven by GitHub Actions (over SSH) or an operator.
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
# Secrets: DATABASE_URL, AUTH_SECRET, POSTGRES_PASSWORD, LEASEWEB_API_KEY etc.
# live in ${COMPOSE_DIR}/.env (created by server-bootstrap.sh; NEVER in git).
# docker compose reads that .env automatically because it sits next to the
# generated compose file.
#
# GHCR access:
#   - Anonymous `docker pull` is attempted first -> works for PUBLIC packages.
#   - If that fails and GHCR_USERNAME+GHCR_TOKEN are provided, deploy.sh runs
#     `echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME"
#     --password-stdin` on the server, then retries the pull. The token is
#     never echoed and never written to the repository or the image.
# =============================================================================
set -Eeuo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
CLOUD_PORT="${CLOUD_PORT:-8540}"
PROJECT="tofan-cloud"
CONTAINER="tofan-cloud"
API_CONTAINER="tofan-cloud-api"
WORKER_CONTAINER="tofan-cloud-worker"

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
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "8000"
      DATABASE_URL: \${DATABASE_URL:?DATABASE_URL must be set in ${COMPOSE_DIR}/.env}
      REDIS_URL: \${REDIS_URL:?REDIS_URL must be set in ${COMPOSE_DIR}/.env}
      AUTH_SECRET: \${AUTH_SECRET:?AUTH_SECRET must be set in ${COMPOSE_DIR}/.env}
      COOKIE_SECURE: \${COOKIE_SECURE:-true}
      CORS_ORIGIN: \${CORS_ORIGIN:-}
      LEASEWEB_MODE: \${LEASEWEB_MODE:-mock}
      LEASEWEB_API_BASE_URL: \${LEASEWEB_API_BASE_URL:-https://api.leaseweb.com}
      LEASEWEB_API_KEY: \${LEASEWEB_API_KEY:-}
      LEASEWEB_ORDERING_ENABLED: \${LEASEWEB_ORDERING_ENABLED:-false}
      DEFAULT_PROVIDER: \${DEFAULT_PROVIDER:-leaseweb}
      QUOTE_TTL_MINUTES: \${QUOTE_TTL_MINUTES:-15}
      RENEWAL_LOOKAHEAD_DAYS: \${RENEWAL_LOOKAHEAD_DAYS:-3}
      RENEWAL_GRACE_DAYS: \${RENEWAL_GRACE_DAYS:-3}
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
      cloud-postgres:
        condition: service_healthy
      cloud-redis:
        condition: service_healthy
    networks:
      - ${PROJECT}_net
    environment:
      NODE_ENV: production
      DATABASE_URL: \${DATABASE_URL:?DATABASE_URL must be set in ${COMPOSE_DIR}/.env}
      REDIS_URL: \${REDIS_URL:?REDIS_URL must be set in ${COMPOSE_DIR}/.env}
      AUTH_SECRET: \${AUTH_SECRET:?AUTH_SECRET must be set in ${COMPOSE_DIR}/.env}
      LEASEWEB_MODE: \${LEASEWEB_MODE:-mock}
      LEASEWEB_API_BASE_URL: \${LEASEWEB_API_BASE_URL:-https://api.leaseweb.com}
      LEASEWEB_API_KEY: \${LEASEWEB_API_KEY:-}
      LEASEWEB_ORDERING_ENABLED: \${LEASEWEB_ORDERING_ENABLED:-false}
      DEFAULT_PROVIDER: \${DEFAULT_PROVIDER:-leaseweb}
      QUOTE_TTL_MINUTES: \${QUOTE_TTL_MINUTES:-15}
      RENEWAL_LOOKAHEAD_DAYS: \${RENEWAL_LOOKAHEAD_DAYS:-3}
      RENEWAL_GRACE_DAYS: \${RENEWAL_GRACE_DAYS:-3}
      LOG_LEVEL: \${LOG_LEVEL:-info}
    command: ["npm", "run", "start:worker"]
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
    container_name: tofan-cloud-postgres
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

  cloud-redis:
    image: redis:7-alpine
    container_name: tofan-cloud-redis
    restart: unless-stopped
    networks:
      - ${PROJECT}_net
    command: ["redis-server", "--appendonly", "no", "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]
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

volumes:
  cloud-postgres-data:

networks:
  ${PROJECT}_net:
    name: ${PROJECT}_net
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
  if [[ -z "${PREV_IMAGE}" || -z "${PREV_API_IMAGE}" ]]; then
    die "No previous image pair recorded — cannot roll back. Manual intervention required."
    return 1
  fi

  if ! pull_image "${PREV_IMAGE}"; then
    die "Could not pull previous web image ${PREV_IMAGE} during rollback."
    return 1
  fi
  if ! pull_image "${PREV_API_IMAGE}"; then
    die "Could not pull previous api image ${PREV_API_IMAGE} during rollback."
    return 1
  fi

  write_compose "${PREV_IMAGE}" "${PREV_API_IMAGE}" "${FINAL}"
  if docker compose -f "${FINAL}" up -d; then
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

# From here on we are mutating the running deployment; enable the rollback trap.
UPDATING=1

# --- write config + deploy -----------------------------------------------------
write_compose "$IMAGE" "$API_IMAGE" "$FINAL"
if ! docker compose -f "$FINAL" up -d; then
  rollback "docker compose up failed for ${IMAGE} + ${API_IMAGE}" || exit 1
  exit 2
fi

# mark attempted images (so a failed state still records what we tried)
meta_set image "${IMAGE}"
meta_set api_image "${API_IMAGE}"

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
CUR_SHA="${IMAGE##*:}"
meta_set image "$IMAGE"
meta_set api_image "$API_IMAGE"
meta_set sha "$CUR_SHA"
meta_set deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
meta_set public_url "$PUBLIC_URL"

good "DEPLOYMENT SUCCEEDED"
printf "%-32s : %s\n" "Commit SHA" "$CUR_SHA"
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