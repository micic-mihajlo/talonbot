#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${TALONBOT_ENV_FILE:-/etc/talonbot/talonbot.env}"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="${ROOT_DIR}/.env"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DATA_DIR="${DATA_DIR:-/var/lib/talonbot}"
CONTROL_SOCKET_PATH="${CONTROL_SOCKET_PATH:-$DATA_DIR/control.sock}"
SOCKET_DIR="$(dirname "$CONTROL_SOCKET_PATH")"
PGID_FILE="$DATA_DIR/runtime/launcher.pgid"

mkdir -p "$DATA_DIR/runtime" "$SOCKET_DIR"

log() {
  echo "[start] $*"
}

warn() {
  echo "[start][warn] $*"
}

umask 077

if [ -x "$ROOT_DIR/bin/harden-permissions.sh" ]; then
  "$ROOT_DIR/bin/harden-permissions.sh" || warn "harden-permissions failed"
fi

if [ -x "$ROOT_DIR/bin/prune-session-logs.sh" ]; then
  "$ROOT_DIR/bin/prune-session-logs.sh" "${SESSION_LOG_RETENTION_DAYS:-14}" >/dev/null 2>&1 || warn "prune-session-logs failed"
fi

if [ -x "$ROOT_DIR/bin/redact-logs.sh" ]; then
  "$ROOT_DIR/bin/redact-logs.sh" >/dev/null 2>&1 || warn "redact-logs failed"
fi

if [ -x "$ROOT_DIR/bin/verify-manifest.sh" ]; then
  "$ROOT_DIR/bin/verify-manifest.sh" || {
    log "manifest verification failed"
    exit 1
  }
fi

if [ -d "$SOCKET_DIR" ]; then
  find "$SOCKET_DIR" -maxdepth 1 -type s -name '*.sock' -print0 2>/dev/null | while IFS= read -r -d '' sock; do
    if command -v fuser >/dev/null 2>&1; then
      if ! fuser "$sock" >/dev/null 2>&1; then
        rm -f "$sock"
      fi
    else
      rm -f "$sock"
    fi
  done
fi

if [ -f "$PGID_FILE" ]; then
  old_pgid="$(cat "$PGID_FILE" 2>/dev/null || true)"
  if [ -n "$old_pgid" ] && kill -0 "-$old_pgid" >/dev/null 2>&1; then
    log "terminating previous launcher process group $old_pgid"
    kill -TERM "-$old_pgid" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -f "$PGID_FILE"
fi

echo $$ > "$PGID_FILE"
log "starting talonbot runtime from $ROOT_DIR"
exec node "$ROOT_DIR/dist/index.js"
