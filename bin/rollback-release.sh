#!/usr/bin/env bash
set -euo pipefail

TARGET="previous"

usage() {
  echo "Usage: $0 [--target previous|<sha>|<absolute-path>]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      TARGET="$1"
      shift
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "rollback-release requires root privileges (run with sudo)."
  exit 1
fi

RELEASE_ROOT_DIR="${RELEASE_ROOT_DIR:-/opt/talonbot}"
CURRENT_LINK="$RELEASE_ROOT_DIR/current"
PREVIOUS_LINK="$RELEASE_ROOT_DIR/previous"
HEALTHCHECK_URL="${RELEASE_HEALTHCHECK_URL:-http://127.0.0.1:${CONTROL_HTTP_PORT:-8080}/health}"
HEALTHCHECK_TIMEOUT_MS="${RELEASE_HEALTHCHECK_TIMEOUT_MS:-45000}"

current_path="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
if [ -z "$current_path" ] || [ ! -d "$current_path" ]; then
  echo "current release missing"
  exit 1
fi

if [ "$TARGET" = "previous" ]; then
  target_path="$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)"
else
  if [ -d "$TARGET" ]; then
    target_path="$(cd "$TARGET" && pwd)"
  else
    target_path="$RELEASE_ROOT_DIR/releases/$TARGET"
  fi
fi

if [ -z "${target_path:-}" ] || [ ! -d "$target_path" ]; then
  echo "rollback target not found: $TARGET"
  exit 1
fi

ln -sfn "$target_path" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
ln -sfn "$current_path" "$PREVIOUS_LINK.next"
mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files talonbot.service >/dev/null 2>&1; then
  systemctl restart talonbot.service
fi

if command -v curl >/dev/null 2>&1; then
  timeout_s=$((HEALTHCHECK_TIMEOUT_MS / 1000))
  [ "$timeout_s" -lt 5 ] && timeout_s=5
  ok=0
  for i in $(seq 1 "$timeout_s"); do
    if curl -fsS "$HEALTHCHECK_URL" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done

  if [ "$ok" -ne 1 ]; then
    echo "rollback health check failed, restoring previous current release"
    ln -sfn "$current_path" "$CURRENT_LINK.next"
    mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
    ln -sfn "$target_path" "$PREVIOUS_LINK.next"
    mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files talonbot.service >/dev/null 2>&1; then
      systemctl restart talonbot.service
    fi
    exit 1
  fi
fi

echo "rolled back to: $target_path"
