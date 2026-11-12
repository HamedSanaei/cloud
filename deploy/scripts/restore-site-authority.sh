#!/usr/bin/env bash
# Fail-safe for an unsuccessful first website-source release.
# Restore only the SHA-bound encrypted pre-cutover .env; never modify the DB.
set -Eeuo pipefail
umask 077
COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
RELEASE_SHA="${RELEASE_SHA:?RELEASE_SHA is required}"
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid restoration SHA" >&2; exit 1; }
META="$COMPOSE_DIR/deployed.version"
ENV_FILE="$COMPOSE_DIR/.env"
MARKER="$COMPOSE_DIR/.site-authority-approved"
[[ -f "$META" && -f "$ENV_FILE" ]] || { echo "Live website metadata is missing" >&2; exit 1; }
if [[ "${1:-}" != "--lock-held" ]]; then
  exec 9>"$COMPOSE_DIR/.deployment.lock"
  flock -w 180 9 || { echo "Release lock busy; cannot restore env" >&2; exit 1; }
  exec 8>/var/lock/servercloud-platform-release.lock
  flock -w 180 8 || { echo "Platform release lock busy; cannot restore env" >&2; exit 1; }
fi
prior_mode="$(grep -E '^data_authority=' "$META" | tail -n1 | cut -d= -f2- || true)"
if [[ "$prior_mode" == site ]]; then
  echo "Website source already confirmed in release metadata; no restoration needed"
  exit 0
fi
if [[ ! -f "$MARKER" || "$(cat "$MARKER")" != "$RELEASE_SHA" ]]; then
  echo "No matching pending source change; no restoration needed"
  exit 0
fi
prev_sha="$(grep -E '^sha=' "$META" | tail -n1 | cut -d= -f2- || true)"
[[ "$prev_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Original release SHA missing" >&2; exit 1; }
saved="$COMPOSE_DIR/backups/pre-site-authority-${prev_sha}-${RELEASE_SHA}.env.gpg"
[[ -s "$saved" ]] || { echo "Encrypted original environment missing" >&2; exit 1; }
key="$(grep '^BACKUP_ENCRYPTION_KEY=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
case "$key" in \"*\") key="${key:1:${#key}-2}" ;; \'*\') key="${key:1:${#key}-2}" ;; esac
[[ "${#key}" -ge 32 ]] || { echo "Encrypted restoration key missing" >&2; exit 1; }
temp="$(mktemp "$COMPOSE_DIR/.env.restore.XXXXXX")"
trap 'rm -f -- "$temp"' EXIT
if ! gpg --batch --yes --pinentry-mode loopback --no-symkey-cache \
    --passphrase-fd 3 --decrypt --output "$temp" "$saved" 3<<<"$key" >/dev/null 2>&1; then
  echo "Could not decrypt original environment, leaving current file unchanged" >&2
  exit 1
fi
unset key
[[ -s "$temp" ]] || { echo "Original environment is empty; refusing to install" >&2; exit 1; }
chmod 0600 "$temp"
mv -f -- "$temp" "$ENV_FILE"
rm -f -- "$MARKER"
echo "Original Python-source environment restored safely; business records preserved"
