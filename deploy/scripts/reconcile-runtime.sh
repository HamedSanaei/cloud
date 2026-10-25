#!/usr/bin/env bash
# Recover only verified existing infrastructure. Never compose up/create here.
set -Eeuo pipefail
COMPOSE_DIR="${COMPOSE_DIR:-/opt/tofan/cloud}"
export COMPOSE_DIR
strict=0
held=0
for arg in "$@"; do
  case "$arg" in
    --check|--require-active) strict=1 ;;
    --lock-held) held=1 ;;
    *) printf '[reconcile] Unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done
[[ -d "$COMPOSE_DIR" ]] || { echo '[reconcile] Deployment directory missing' >&2; exit 1; }
if (( held )); then
  # Only the deploy process may pass its already-held lock description.
  if [[ "$(readlink /proc/$$/fd/9)" != "$COMPOSE_DIR/.deployment.lock" ]] || ! flock -n 9; then
    echo '[reconcile] Inherited deployment lock missing or busy' >&2; exit 1
  fi
else
  exec 9>"$COMPOSE_DIR/.deployment.lock"
  flock -w "${RECONCILE_LOCK_TIMEOUT_SECONDS:-600}" 9 || {
    echo '[reconcile] Deployment lock busy; no runtime changes' >&2; exit 1;
  }
fi
if [[ -e "$COMPOSE_DIR/.maintenance" ]]; then
  echo '[reconcile] Maintenance mode: no runtime changes'
  (( strict == 0 )) && exit 0
  exit 1
fi
exec python3 "$(dirname "${BASH_SOURCE[0]}")/runtime-reconcile.py" "$@"
