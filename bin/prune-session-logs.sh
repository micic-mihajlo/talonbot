#!/usr/bin/env bash
set -euo pipefail

DAYS="${1:-${SESSION_LOG_RETENTION_DAYS:-14}}"
DATA_DIR="${DATA_DIR:-$HOME/.local/share/talonbot}"
SESSIONS_DIR="$DATA_DIR/sessions"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "prune-session-logs: invalid days '$DAYS'"
  exit 1
fi

if [ ! -d "$SESSIONS_DIR" ]; then
  echo "prune-session-logs: no sessions directory"
  exit 0
fi

pruned=0
while IFS= read -r dir; do
  [ -d "$dir" ] || continue
  rm -rf "$dir"
  pruned=$((pruned + 1))
done < <(find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$DAYS")

echo "prune-session-logs: pruned=$pruned"
