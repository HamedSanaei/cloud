#!/usr/bin/env bash
# One-time guarded switch of an EMPTY website installation away from Python.
# Invoked by a tested staging release with the same remote deploy identity.
# Never rewrites customer records or revokes third-party platform credentials.
set -Eeuo pipefail
umask 077
COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
RELEASE_SHA="${RELEASE_SHA:?RELEASE_SHA required}"
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid approved SHA" >&2; exit 1; }
ENV_FILE="$COMPOSE_DIR/.env"
META="$COMPOSE_DIR/deployed.version"
MARKER="$COMPOSE_DIR/.site-authority-approved"
[[ -f "$ENV_FILE" && -f "$META" ]] || { echo "expected website release not found" >&2; exit 1; }
command -v docker >/dev/null && command -v gpg >/dev/null && command -v python3 >/dev/null
exec 9>"$COMPOSE_DIR/.deployment.lock"
flock -w 180 9 || { echo "another deployment in progress" >&2; exit 1; }
exec 8>/var/lock/servercloud-platform-release.lock
flock -w 180 8 || { echo "shared deployment lock busy" >&2; exit 1; }
old="$(grep -E '^DATA_AUTHORITY=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
old="${old:-auto}"
if [[ "$old" == site ]]; then
  echo "Site is already canonical; no migration required"
  exit 0
fi
[[ "$old" == auto || "$old" == platform ]] || { echo "unexpected previous authority" >&2; exit 1; }
prev_sha="$(grep -E '^sha=' "$META" | tail -n1 | cut -d= -f2- || true)"
[[ "$prev_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "verified previous release missing" >&2; exit 1; }
# Fail closed on ANY financial/server activity. Users & zero-value wallets
# are allowed, but even test orders need an explicit separate review.
state="$(docker exec tofan-cloud-postgres psql -X -A -t -v ON_ERROR_STOP=1 -U cloud -d cloud -c "
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM platform_links)
  OR EXISTS (SELECT 1 FROM wallet_transactions)
  OR EXISTS (SELECT 1 FROM wallets WHERE balance_rial <> 0)
  OR EXISTS (SELECT 1 FROM orders)
  OR EXISTS (SELECT 1 FROM servers)
  OR EXISTS (SELECT 1 FROM subscriptions)
  OR EXISTS (SELECT 1 FROM invoices)
  OR EXISTS (SELECT 1 FROM provider_operations)
  OR EXISTS (SELECT 1 FROM charge_requests)
THEN 'BLOCKED_HAS_BUSINESS_DATA' ELSE 'EMPTY_SITE' END;" 2>/dev/null)" || { echo "cannot verify source dataset, leaving authority unchanged" >&2; exit 1; }
[[ "$state" == EMPTY_SITE ]] || { echo "source change rejected: existing financial/server data or platform links" >&2; exit 1; }

backup_key="$(grep '^BACKUP_ENCRYPTION_KEY=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
case "$backup_key" in \"*\") backup_key="${backup_key:1:${#backup_key}-2}" ;; \'*\') backup_key="${backup_key:1:${#backup_key}-2}" ;; esac
[[ "${#backup_key}" -ge 32 ]] || { echo "encrypted backup key missing" >&2; exit 1; }
install -d -m 0700 "$COMPOSE_DIR/backups"
backup="$COMPOSE_DIR/backups/pre-site-authority-${prev_sha}-${RELEASE_SHA}.env.gpg"
if [[ ! -f "$backup" ]]; then
  printf '%s' "$backup_key" | gpg --batch --yes --pinentry-mode loopback --no-symkey-cache \
    --symmetric --cipher-algo AES256 --passphrase-fd 0 --output "$backup" "$ENV_FILE" >/dev/null 2>&1 || {
    rm -f -- "$backup"; echo "encrypted environment backup failed" >&2; exit 1;
  }
  chmod 0600 "$backup"
fi
unset backup_key
# Optional empty provider TOML lets the website own existing inventory without
# silently enabling unconfigured paid provider ordering.
provider="$(grep -E '^CLOUD_CONFIG_FILE=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
provider="${provider:-$COMPOSE_DIR/configuration.toml}"
[[ "$provider" == /* && "$provider" != *$'\n'* ]] || { echo "invalid private provider config path" >&2; exit 1; }
if [[ ! -e "$provider" ]]; then
  install -d -m 0700 "$(dirname "$provider")"
  printf '[storefront.catalog_sync]\nenabled = false\n' >"$provider"
  chmod 0600 "$provider"
fi
[[ -f "$provider" ]] || { echo "provider config missing" >&2; exit 1; }

# Atomic update: preserve all secrets and fields; alter only the explicit mode.
ENV_FILE="$ENV_FILE" python3 - <<'PY'
import os
import tempfile
from pathlib import Path
p = Path(os.environ['ENV_FILE'])
old = p.read_bytes()
lines = old.splitlines(keepends=True)
result = []
for line in lines:
    if line.startswith(b'DATA_AUTHORITY='):
        continue
    result.append(line)
if result and not result[-1].endswith(b'\n'):
    result.append(b'\n')
result.append(b'DATA_AUTHORITY=site\n')
fd, temp = tempfile.mkstemp(prefix='.env.site.', dir=p.parent)
try:
    with os.fdopen(fd, 'wb') as f:
        f.write(b''.join(result))
        f.flush()
        os.fsync(f.fileno())
    os.chmod(temp, 0o600)
    os.replace(temp, p)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
PY
printf '%s\n' "$RELEASE_SHA" >"$MARKER"
chmod 0600 "$MARKER"
echo "Empty installation promoted to website authority; encrypted previous env kept, release approved"
