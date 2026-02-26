#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

DATA_DIR="${DATA_DIR:-$HOME/.local/share/talonbot}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config}"
WORKTREE_ROOT_DIR="${WORKTREE_ROOT_DIR:-$HOME/workspace/worktrees}"

mkdir -p "$DATA_DIR" "$DATA_DIR/sessions" "$DATA_DIR/memory" "$DATA_DIR/security" "$WORKTREE_ROOT_DIR" "$CONFIG_DIR"

chmod 700 "$DATA_DIR" "$DATA_DIR/sessions" "$DATA_DIR/memory" "$DATA_DIR/security" "$WORKTREE_ROOT_DIR" "$CONFIG_DIR" 2>/dev/null || true

if [ -f "$CONFIG_DIR/.env" ]; then
  chmod 600 "$CONFIG_DIR/.env" 2>/dev/null || true
fi

find "$DATA_DIR/sessions" -type d -exec chmod 700 {} + 2>/dev/null || true
find "$DATA_DIR/sessions" -type f -name '*.jsonl' -exec chmod 600 {} + 2>/dev/null || true

echo "harden-permissions: ok"
