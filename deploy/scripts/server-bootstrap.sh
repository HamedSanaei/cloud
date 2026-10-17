#!/usr/bin/env bash
# =============================================================================
# One-time bootstrap on the authorized shared production deployment target.
# Run manually as root; this does not deploy or restart any application:
#
#   sudo bash server-bootstrap.sh
#
# Safety:
#   - checks Docker + Docker Compose exist
#   - checks the selected CLOUD_PORT is free; FAILS safely (never kills the
#     process holding it) and tells you to pick another port
#   - touches ONLY the selected COMPOSE_DIR, never unrelated services
#   - installs/updates ONLY the Cloud deploy scripts
#   - uses restrictive permissions (no chmod 777)
#   - does NOT open the application port publicly (compose always binds 127.0.0.1)
#   - does NOT run docker prune / remove containers/networks/images
# =============================================================================
set -Eeuo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
CLOUD_PORT="${CLOUD_PORT:-8540}"

die()  { printf "[XX] %s\n" "$*" >&2; exit 1; }
info() { printf "[i] %s\n" "$*"; }
good() { printf "[ok] %s\n" "$*"; }

if (( EUID != 0 )); then
  die "Please run as root (sudo)."
fi

info "Deployment dir : ${COMPOSE_DIR}"
info "Local port     : ${CLOUD_PORT}"

# --- 1) Docker + Docker Compose ------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker not found on this server — install Docker first."
for dependency in openssl flock gpg curl; do
  command -v "$dependency" >/dev/null 2>&1 || die "Required dependency missing: $dependency"
done
docker compose version >/dev/null 2>&1 || die "docker compose (v2) not available — install the compose plugin first."
good "docker + docker compose available"

# --- 2) Verify the selected port is free (bind to 127.0.0.1 only) --------------
# Do NOT kill or change whatever is using it — fail safely and ask for another port.
port_occupied=0
listeners=''

# Probe with every tool available on the box (ss / netstat / /dev/tcp).
if command -v ss >/dev/null 2>&1 && ss -lnt 2>/dev/null | grep -E "[:.]${CLOUD_PORT}\b" >/dev/null; then
  port_occupied=1
  listeners="$(ss -lntp 2>/dev/null | grep -E "[:.]${CLOUD_PORT}\b")"
elif command -v netstat >/dev/null 2>&1 && netstat -lnt 2>/dev/null | grep -E "[:.]${CLOUD_PORT}\b" >/dev/null; then
  port_occupied=1
  listeners="$(netstat -lntp 2>/dev/null | grep -E "[:.]${CLOUD_PORT}\b")"
elif (exec 3<>/dev/tcp/127.0.0.1/${CLOUD_PORT}) 2>/dev/null; then
  exec 3<&- 3>&- 2>/dev/null || true
  port_occupied=1
  listeners="127.0.0.1:${CLOUD_PORT} is accepting TCP connections"
fi

if (( port_occupied )); then
  echo
  echo "[XX] Port ${CLOUD_PORT} is already in use on this server:"
  echo "${listeners}"
  echo
  echo "     The tofan-cloud deployment uses 127.0.0.1:${CLOUD_PORT} only."
  echo "     Select a different, free port and re-run, e.g.:"
  echo "       sudo env CLOUD_PORT=18744 bash server-bootstrap.sh"
  die "Port ${CLOUD_PORT} is occupied — nothing was changed."
fi

# Also confirm no running container already publishes it.
if docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null | grep -E "[:.]${CLOUD_PORT}->" >/dev/null; then
  echo
  echo "[XX] A running container already publishes port ${CLOUD_PORT}:"
  docker ps --format 'table {{.Names}}\t{{.Ports}}' 2>/dev/null | head -20
  echo
  echo "     Choose a different, free port and re-run."
  die "Port ${CLOUD_PORT} is published by an existing container — nothing was changed."
fi
good "port ${CLOUD_PORT} is free"

# --- 3) Create the deployment directory (touches nothing else) -----------------
mkdir -p "${COMPOSE_DIR}/scripts"
mkdir -p "${COMPOSE_DIR}/backups"
install -d -o root -g root -m 0755 "${COMPOSE_DIR}"
install -d -o root -g root -m 0755 "${COMPOSE_DIR}/scripts"
install -d -o root -g root -m 0700 "${COMPOSE_DIR}/backups"

# --- 4) Install/update only the Cloud deploy script -----------------------------
SCRIPT_SRC="$([ -f "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" ] && echo "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" || echo '')"
if [[ -n "$SCRIPT_SRC" ]]; then
  install -m 0755 -o root -g root "${SCRIPT_SRC}" "${COMPOSE_DIR}/scripts/deploy.sh"
  good "installed deploy.sh -> ${COMPOSE_DIR}/scripts/deploy.sh"
else
  info "WARN: deploy.sh not found beside bootstrap; the GitHub Actions workflow will push it at first deploy."
fi

# --- 5) Secrets .env template (NEVER committed; used by docker compose) --------
# Only created when missing; existing values are never overwritten.
ENV_FILE="${COMPOSE_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  database_password="$(openssl rand -hex 32)"
  auth_secret="$(openssl rand -hex 32)"
  backup_key="$(openssl rand -hex 32)"
  install -m 0600 -o root -g root /dev/null "${ENV_FILE}"
  {
    echo "# tofan-cloud production secrets — never commit; chmod 600."
    echo "# docker compose reads this file automatically from ${COMPOSE_DIR}."
    echo
    echo "# --- database / redis ---"
    echo "DATABASE_URL=postgres://cloud:${database_password}@cloud-postgres:5432/cloud"
    echo "REDIS_URL=redis://cloud-redis:6379"
    echo "POSTGRES_PASSWORD=${database_password}"
    echo
    echo "# --- auth ---"
    echo "AUTH_SECRET=${auth_secret}"
    echo "COOKIE_SECURE=true"
    echo "CORS_ORIGIN="
    echo
    echo "# Canonical platform MUST be deployed in this same environment first."
    echo "APP_ENV=production"
    echo "PLATFORM_API_URL=http://cloud-platform-api:8000"
    echo "AUTH_DELIVERY_MODE=live"
    echo "FRONTEND_URL="
    echo "SMTP_HOST="
    echo "SMTP_PORT=587"
    echo "SMTP_USER="
    echo "SMTP_PASSWORD="
    echo "SMTP_FROM="
    echo "PARSGREEN_SIGNATURE="
    echo "PARSGREEN_FROM="
    echo "GOOGLE_CLIENT_ID="
    echo "GOOGLE_CLIENT_SECRET="
    echo "BACKUP_ENCRYPTION_KEY=${backup_key}"
    echo "LOG_LEVEL=info"
  } >"${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  unset database_password auth_secret backup_key
  good "created private infrastructure secrets; configure FRONTEND_URL and live authentication delivery"
else
  info ".env already exists — leaving it untouched."
fi

# --- 6) Starter metadata (empty images => first deploy has nothing to roll back to)
if [[ ! -f "${COMPOSE_DIR}/deployed.version" ]]; then
  install -m 0644 -o root -g root /dev/null "${COMPOSE_DIR}/deployed.version"
  printf 'sha=\nimage=\napi_image=\ndeployed_at=\npublic_url=\n' >"${COMPOSE_DIR}/deployed.version"
  good "created empty deployed.version"
else
  info "deployed.version already exists — leaving it untouched."
fi

echo
echo "=== tofan-cloud server bootstrap complete ==="
echo "  Deployment dir  : ${COMPOSE_DIR}"
echo "  Local port      : 127.0.0.1:${CLOUD_PORT}"
echo "  (application port is loopback-only; PostgreSQL/Redis/API have NO public port)"
echo
echo "IMPORTANT — before the first deploy:"
echo "  1. EDIT ${COMPOSE_DIR}/.env and set:"
echo "       FRONTEND_URL, CORS_ORIGIN and live SMTP/SMS/OAuth settings"
echo "     Database/auth/backup keys were generated only when the file was absent."
echo "  2. Deploy the matching canonical Python platform with its own private TOML."
echo "     This website no longer receives provider credentials or a provider TOML."
echo "     Staging updates this SAME live runtime; do not create a second stack or bot."
echo
echo "Next steps:"
echo "  1. Configure the website HTTPS virtual host -> 127.0.0.1:${CLOUD_PORT}."
echo "     Do not alter another application's ingress or restart unrelated services."
echo "  2. Configure staging/production GitHub Environment secrets for this SAME target:"
echo "     DEPLOY_HOST, DEPLOY_PORT, DEPLOY_USER, DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS."
echo "     Set Environment variables DEPLOY_PATH, CLOUD_PORT and PUBLIC_URL."
echo "  3. Staging automatically updates the live website after CI."
echo "     The main lane remains manual with explicit confirmation and reviewer approval."
echo
echo "  NOTE: The very FIRST deploy can be run with SKIP_PUBLIC_HEALTHCHECK=1"
echo "        if DNS/reverse-proxy/Cloudflare are not ready yet. All normal"
echo "        deployments after setup require the public health checks."