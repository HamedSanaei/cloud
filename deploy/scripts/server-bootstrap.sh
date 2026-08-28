#!/usr/bin/env bash
# =============================================================================
# One-time bootstrap for the tofan-cloud deployment ON the production server.
# Run manually (as root / sudo) exactly once before the first CI deployment:
#
#   sudo env CLOUD_PORT=8540 bash server-bootstrap.sh
#
# Safety:
#   - checks Docker + Docker Compose exist
#   - checks the selected CLOUD_PORT is free; FAILS safely (never kills the
#     process holding it) and tells you to pick another port
#   - touches ONLY /opt/tofan/cloud (never Vendora or other services)
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
command -v docker >/dev/null 2>&1
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
  echo "       sudo env CLOUD_PORT=8744 bash server-bootstrap.sh"
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
install -d -o root -g root -m 0755 "${COMPOSE_DIR}/backups"

# --- 4) Install/update only the Cloud deploy script -----------------------------
SCRIPT_SRC="$([ -f "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" ] && echo "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" || echo '')"
if [[ -n "$SCRIPT_SRC" ]]; then
  install -m 0755 -o root -g root "${SCRIPT_SRC}" "${COMPOSE_DIR}/scripts/deploy.sh"
  good "installed deploy.sh -> ${COMPOSE_DIR}/scripts/deploy.sh"
else
  info "WARN: deploy.sh not found beside bootstrap; the GitHub Actions workflow will push it at first deploy."
fi

# --- 5) Starter metadata (empty image => first deploy has nothing to roll back to)
if [[ ! -f "${COMPOSE_DIR}/deployed.version" ]]; then
  install -m 0644 -o root -g root /dev/null "${COMPOSE_DIR}/deployed.version"
  printf 'sha=\nimage=\ndeployed_at=\npublic_url=\n' >"${COMPOSE_DIR}/deployed.version"
  good "created empty deployed.version"
else
  info "deployed.version already exists — leaving it untouched."
fi

echo
echo "=== tofan-cloud server bootstrap complete ==="
echo "  Deployment dir  : ${COMPOSE_DIR}"
echo "  Local port      : 127.0.0.1:${CLOUD_PORT}"
echo "  (application port is loopback-only and never exposed publicly)"
echo
echo "Next steps:"
echo "  1. INSPECT your existing ingress/Vendora setup, then add a dedicated"
echo "     virtual host for cloud.tofanservice.ir -> http://127.0.0.1:${CLOUD_PORT}"
echo "     (see docs/DEPLOYMENT.md — do not modify the Vendora vhost)."
echo "  2. Add the Cloudflare DNS record: A, name=cloud, target=<server IP>,"
echo "     Proxied. SSL/TLS = Full (strict)."
echo "  3. Create GitHub Actions Secrets: DEPLOY_HOST, DEPLOY_PORT,"
echo "     DEPLOY_USER, DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS"
echo "     (+ GHCR_USERNAME & GHCR_TOKEN if the GHCR package is private)."
echo "  4. Trigger the 'Build, Publish to GHCR, and Deploy' workflow."
echo
echo "  NOTE: The very FIRST deploy can be run with SKIP_PUBLIC_HEALTHCHECK=1"
echo "        if DNS/reverse-proxy/Cloudflare are not ready yet. All normal"
echo "        deployments after setup require the public health checks."