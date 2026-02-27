#!/usr/bin/env bash
set -euo pipefail

TOKEN="${CONTROL_AUTH_TOKEN:-ci-control-token-very-long-without-shortcuts}"
PORT="${CONTROL_HTTP_PORT:-8080}"
RUNTIME_LOG="${RUNTIME_LOG:-/tmp/talonbot-runtime.log}"
RUNTIME_ROOT="${RUNTIME_ROOT:-$(mktemp -d /tmp/talonbot-ci-runtime-XXXXXX)}"
DATA_DIR="${DATA_DIR:-$RUNTIME_ROOT/data}"
CONTROL_SOCKET_PATH="${CONTROL_SOCKET_PATH:-$DATA_DIR/control.sock}"
ENGINE_CWD="${ENGINE_CWD:-$RUNTIME_ROOT/engine}"
WORKTREE_ROOT_DIR="${WORKTREE_ROOT_DIR:-$RUNTIME_ROOT/worktrees}"
REPO_ROOT_DIR="${REPO_ROOT_DIR:-$RUNTIME_ROOT/workspace}"
RELEASE_ROOT_DIR="${RELEASE_ROOT_DIR:-$RUNTIME_ROOT/releases}"

mkdir -p "$DATA_DIR" "$ENGINE_CWD" "$WORKTREE_ROOT_DIR" "$REPO_ROOT_DIR" "$RELEASE_ROOT_DIR"

CONTROL_AUTH_TOKEN="$TOKEN" \
CONTROL_HTTP_PORT="$PORT" \
DATA_DIR="$DATA_DIR" \
CONTROL_SOCKET_PATH="$CONTROL_SOCKET_PATH" \
ENGINE_CWD="$ENGINE_CWD" \
WORKTREE_ROOT_DIR="$WORKTREE_ROOT_DIR" \
REPO_ROOT_DIR="$REPO_ROOT_DIR" \
RELEASE_ROOT_DIR="$RELEASE_ROOT_DIR" \
ENGINE_MODE=mock \
DISCORD_ENABLED=false \
SLACK_ENABLED=false \
node dist/index.js > "$RUNTIME_LOG" 2>&1 &
runtime_pid=$!

cleanup() {
  kill "$runtime_pid" 2>/dev/null || true
  wait "$runtime_pid" 2>/dev/null || true
  rm -rf "$RUNTIME_ROOT"
}
trap cleanup EXIT

ready=0
for i in $(seq 1 30); do
  if curl -sS "http://127.0.0.1:${PORT}/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "runtime failed to start"
  cat "$RUNTIME_LOG"
  exit 1
fi

curl -sS -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/status" >/dev/null
curl -sS -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/sessions" >/dev/null
curl -sS -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/release/status" >/dev/null

curl -sS \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"source":"discord","channelId":"ci","text":"hello ci"}' \
  "http://127.0.0.1:${PORT}/dispatch" >/dev/null

ENGINE_MODE=mock \
DISCORD_ENABLED=true \
DISCORD_TOKEN=ci-discord-token-placeholder \
CONTROL_AUTH_TOKEN="$TOKEN" \
CONTROL_HTTP_PORT="$PORT" \
DATA_DIR="$DATA_DIR" \
CONTROL_SOCKET_PATH="$CONTROL_SOCKET_PATH" \
ENGINE_CWD="$ENGINE_CWD" \
WORKTREE_ROOT_DIR="$WORKTREE_ROOT_DIR" \
REPO_ROOT_DIR="$REPO_ROOT_DIR" \
RELEASE_ROOT_DIR="$RELEASE_ROOT_DIR" \
npm run doctor -- --strict --runtime-url "http://127.0.0.1:${PORT}" --runtime-token "$TOKEN"
