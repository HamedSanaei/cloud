#!/usr/bin/env bash
# =============================================================================
# tofan-cloud deploy script
# Runs ON the production server. Idempotent, immutable, with automatic
# rollback on any failure. Driven by GitHub Actions (over SSH) or an operator.
#
# Usage:
#   deploy.sh <IMAGE> [<PUBLIC_URL>] [<SKIP_PUBLIC_HEALTHCHECK>]
#     IMAGE       Full image reference, e.g. ghcr.io/hamedsanaei/cloud:sha-<sha>
#     PUBLIC_URL  Public base URL for the post-deploy check.
#                 (default: http://127.0.0.1:<port>)
#     SKIP_PUBLIC_HEALTHCHECK  Set to 1 ONLY for the initial bootstrap, before
#                 DNS/reverse-proxy/Cloudflare are configured. Default is "0"
#                 => public checks are REQUIRED and a failure triggers rollback.
#
# Reads env:
#   COMPOSE_DIR     deployment directory (default /opt/tofan/cloud)
#   CLOUD_PORT      localhost-only port   (default 8540)
#   GHCR_USERNAME   username for authenticated GHCR pull (private package)
#   GHCR_TOKEN      token with read:packages for that user (private package)
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

CC_Y="\033[1;33m"; CC_G="\033[1;32m"; CC_R="\033[1;31m"; CC_C="\033[1;36m"; CC_N="\033[0m"
log()  { printf "${CC_C}[i]${CC_N} %s\n" "$*"; }
good() { printf "${CC_G}[ok]${CC_N} %s\n" "$*"; }
warn() { printf "${CC_Y}[! ]${CC_N} %s\n" "$*"; }
die()  { printf "${CC_R}[XX]${CC_N} %s\n" "$*" >&2; }

IMAGE="${1:?deploy.sh <IMAGE> [<PUBLIC_URL>] [<SKIP_PUBLIC_HEALTHCHECK>]}"
PUBLIC_URL="${2:-http://127.0.0.1:${CLOUD_PORT}}"
# SKIP_PUBLIC_HEALTHCHECK: 1 = bootstrap only; anything else = strict (default).
SKIP_PUBLIC=${3:-${SKIP_PUBLIC_HEALTHCHECK:-0}}

# Registry credentials (used only when the package is private).
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"

# --- global safety net ----------------------------------------------------
# Any command that fails between the pull and the final success marker triggers
# an automatic rollback to the previously deployed image (unless rollback
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

# Write a compose file for a given image. Always writes atomically via temp file.
write_compose() {
  local img="$1" out="$2" tmp
  tmp="$(mktemp "${COMPOSE_DIR}/.compose.XXXXXX")"
  cat >"$tmp" <<YAML
name: ${PROJECT}
services:
  cloud:
    image: "${img}"
    container_name: ${CONTAINER}
    restart: unless-stopped
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
    # nginx runs as the unprivileged 'nginx' user (set in the Dockerfile) and
    # needs only these two capabilities to manage its runtime files.
    cap_add:
      - CHOWN
      - SETGID

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

# ---------------------------------------------------------------------------
# rollback <reason> — restores the previous image, waits for health, verifies
# locally, restores metadata. Returns 0 on success.
# ---------------------------------------------------------------------------
rollback() {
  local reason="$1"
  ROLLED_BACK=1   # prevent the ERR trap from re-entering rollback
  warn "ROLLBACK triggered: ${reason}"
  if [[ -z "${PREV_IMAGE}" ]]; then
    die "No previous image recorded — cannot roll back. Manual intervention required."
    return 1
  fi

  if ! pull_image "${PREV_IMAGE}"; then
    die "Could not pull previous image ${PREV_IMAGE} during rollback."
    return 1
  fi

  write_compose "${PREV_IMAGE}" "${FINAL}"
  if docker compose -f "${FINAL}" up -d --no-deps; then
    if wait_healthy && current_healthy; then
      meta_set image "${PREV_IMAGE}"
      meta_set sha "${PREV_SHA}"
      good "Rollback successful — restored previous image ${PREV_IMAGE}"
      return 0
    else
      die "Previous image also failed to become healthy."
      return 1
    fi
  else
    die "Failed to start previous image during rollback."
    return 1
  fi
}

# --- preflight ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { die "docker not found on server"; exit 1; }
docker compose version >/dev/null 2>&1 || { die "docker compose v2 not available"; exit 1; }
mkdir -p "$COMPOSE_DIR"

PREV_IMAGE="$(meta_get image)"
PREV_SHA="$(meta_get sha)"
log "deploy dir    : ${COMPOSE_DIR}"
log "image (new)   : ${IMAGE}"
log "public check  : ${PUBLIC_URL}"
log "skip public hc: ${SKIP_PUBLIC}  (1=initial bootstrap only)"
log "ghcr access   : $([ -n "$GHCR_USERNAME" ] && echo authenticated || echo anonymous)"
log "previous image: ${PREV_IMAGE:-<none>}"

# --- pull new image -----------------------------------------------------------
good "validating + pulling ${IMAGE} ..."
if ! pull_image "${IMAGE}"; then
  die "Failed to pull ${IMAGE}. Nothing changed; aborting."
  exit 1
fi

# From here on we are mutating the running deployment; enable the rollback trap.
UPDATING=1

# --- write config + deploy -----------------------------------------------------
write_compose "$IMAGE" "$FINAL"
if ! docker compose -f "$FINAL" up -d --no-deps; then
  rollback "docker compose up failed for ${IMAGE}" || exit 1
  exit 2
fi

# mark attempted image (so a failed state still records what we tried)
meta_set image "${IMAGE}"

# --- health + local verification ------------------------------------------------
if ! wait_healthy; then
  rollback "healthcheck failed for ${IMAGE}" || exit 1
  exit 2
fi
good "container healthy"

if current_healthy; then
  good "local /healthz OK -> ${HEALTH}"
else
  rollback "local /healthz failed for ${IMAGE}" || exit 1
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
meta_set sha "$CUR_SHA"
meta_set deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
meta_set public_url "$PUBLIC_URL"

good "DEPLOYMENT SUCCEEDED"
printf "%-32s : %s\n" "Commit SHA" "$CUR_SHA"
printf "%-32s : %s\n" "Docker image" "$IMAGE"
printf "%-32s : %s\n" "Container status" "$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
printf "%-32s : %s\n" "Health-check result" "$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)"
printf "%-32s : %s\n" "Local health URL" "$HEALTH"
printf "%-32s : %s\n" "SPA URL" "$SPA"
printf "%-32s : %s\n" "Public URL" "$PUBLIC_URL"
printf "%-32s : %s\n" "Deployment dir/host" "${COMPOSE_DIR} (${CONTAINER})"