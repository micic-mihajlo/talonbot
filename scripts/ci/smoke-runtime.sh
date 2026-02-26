#!/usr/bin/env bash
set -euo pipefail

TOKEN="${CONTROL_AUTH_TOKEN:-ci-control-token-very-long-without-shortcuts}"
PORT="${CONTROL_HTTP_PORT:-8080}"
RUNTIME_LOG="${RUNTIME_LOG:-/tmp/talonbot-runtime.log}"

CONTROL_AUTH_TOKEN="$TOKEN" \
CONTROL_HTTP_PORT="$PORT" \
ENGINE_MODE=mock \
DISCORD_ENABLED=false \
SLACK_ENABLED=false \
node dist/index.js > "$RUNTIME_LOG" 2>&1 &
runtime_pid=$!

cleanup() {
  kill "$runtime_pid" 2>/dev/null || true
  wait "$runtime_pid" 2>/dev/null || true
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
npm run doctor -- --strict --runtime-url "http://127.0.0.1:${PORT}" --runtime-token "$TOKEN"
