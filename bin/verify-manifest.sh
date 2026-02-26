#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

MODE="${STARTUP_INTEGRITY_MODE:-warn}"
RELEASE_ROOT_DIR="${RELEASE_ROOT_DIR:-$HOME/.local/share/talonbot/releases}"
CURRENT_LINK="$RELEASE_ROOT_DIR/current"
DATA_DIR="${DATA_DIR:-$HOME/.local/share/talonbot}"
STATUS_FILE="$DATA_DIR/security/integrity-status.json"

mkdir -p "$(dirname "$STATUS_FILE")"

write_status() {
  local status="$1"
  local checked="$2"
  local missing="$3"
  local mismatches="$4"
  local message="$5"

  cat > "$STATUS_FILE" <<JSON
{
  "checked_at": "$(bb_now_utc)",
  "mode": "$MODE",
  "status": "$status",
  "checked": $checked,
  "missing": $missing,
  "mismatches": $mismatches,
  "message": "$(bb_json_escape "$message")"
}
JSON
}

case "$MODE" in
  off|warn|strict) ;;
  *)
    MODE="warn"
    ;;
esac

if [ "$MODE" = "off" ]; then
  write_status "skipped" 0 0 0 "integrity check disabled"
  echo "verify-manifest: skipped"
  exit 0
fi

if [ ! -L "$CURRENT_LINK" ] && [ ! -e "$CURRENT_LINK" ]; then
  write_status "warn" 0 1 0 "current release link missing"
  echo "verify-manifest: missing current release link"
  [ "$MODE" = "strict" ] && exit 1
  exit 0
fi

CURRENT_DIR="$(bb_realpath "$CURRENT_LINK" 2>/dev/null || true)"
if [ -z "$CURRENT_DIR" ] || [ ! -d "$CURRENT_DIR" ]; then
  write_status "warn" 0 1 0 "failed to resolve current release"
  echo "verify-manifest: failed to resolve current release"
  [ "$MODE" = "strict" ] && exit 1
  exit 0
fi

MANIFEST_FILE="$CURRENT_DIR/release-manifest.json"
if [ ! -f "$MANIFEST_FILE" ]; then
  write_status "warn" 0 1 0 "manifest missing"
  echo "verify-manifest: missing manifest"
  [ "$MODE" = "strict" ] && exit 1
  exit 0
fi

checked=0
missing=0
mismatches=0

while IFS=$'\t' read -r relative expected_hash; do
  [ -n "$relative" ] || continue
  file="$CURRENT_DIR/$relative"
  if [ ! -f "$file" ]; then
    missing=$((missing + 1))
    continue
  fi
  checked=$((checked + 1))
  actual_hash="$(bb_hash_file "$file")"
  if [ "$actual_hash" != "$expected_hash" ]; then
    mismatches=$((mismatches + 1))
  fi
done < <(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const [k,v] of Object.entries(m.files||{})) console.log(`${k}\t${v}`);' "$MANIFEST_FILE")

if [ "$missing" -eq 0 ] && [ "$mismatches" -eq 0 ]; then
  write_status "pass" "$checked" 0 0 "integrity check passed"
  echo "verify-manifest: pass checked=$checked"
  exit 0
fi

write_status "fail" "$checked" "$missing" "$mismatches" "integrity issues found"
echo "verify-manifest: fail checked=$checked missing=$missing mismatches=$mismatches"
[ "$MODE" = "strict" ] && exit 1
exit 0
