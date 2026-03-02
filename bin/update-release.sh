#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR=""
SKIP_RESTART=0

usage() {
  echo "Usage: $0 [--source <path>] [--skip-restart]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --skip-restart)
      SKIP_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "update-release requires root privileges (run with sudo)."
  exit 1
fi

RELEASE_ROOT_DIR="${RELEASE_ROOT_DIR:-/opt/talonbot}"
RELEASES_DIR="$RELEASE_ROOT_DIR/releases"
CURRENT_LINK="$RELEASE_ROOT_DIR/current"
PREVIOUS_LINK="$RELEASE_ROOT_DIR/previous"
RUNTIME_USER="${RUNTIME_EXPECTED_USER:-talonbot}"
HEALTHCHECK_URL="${RELEASE_HEALTHCHECK_URL:-http://127.0.0.1:${CONTROL_HTTP_PORT:-8080}/health}"
HEALTHCHECK_TIMEOUT_MS="${RELEASE_HEALTHCHECK_TIMEOUT_MS:-45000}"

mkdir -p "$RELEASES_DIR"

sha="$(git -C "$SOURCE_DIR" rev-parse --short=12 HEAD 2>/dev/null || true)"
if [ -z "$sha" ]; then
  sha="manual-$(date +%Y%m%d%H%M%S)"
fi

release_dir="$RELEASES_DIR/$sha"
staging_dir="$RELEASES_DIR/.${sha}.tmp-$$"

if [ ! -d "$release_dir" ]; then
  rm -rf "$staging_dir"
  mkdir -p "$staging_dir"

  tar -C "$SOURCE_DIR" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.env' \
    -cf - . | tar -C "$staging_dir" -xf -

  (cd "$staging_dir" && npm ci --omit=dev && npm run build)

  node - <<'NODE' "$staging_dir"
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[2];
const files = {};
const skip = new Set(['node_modules/.bin']);

const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (!rel) continue;
    if (rel === 'release-manifest.json' || rel === 'release-info.json') continue;
    if (skip.has(rel)) continue;
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    files[rel] = hash;
  }
};

walk(root);
fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
NODE

  cat > "$staging_dir/release-info.json" <<JSON
{
  "sha": "$sha",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "sourceDir": "$SOURCE_DIR",
  "manifestFile": "$release_dir/release-manifest.json"
}
JSON

  mv "$staging_dir" "$release_dir"
  chown -R "$RUNTIME_USER:$RUNTIME_USER" "$release_dir" >/dev/null 2>&1 || true
fi

old_current="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
old_previous="$(readlink -f "$PREVIOUS_LINK" 2>/dev/null || true)"
ln -sfn "$release_dir" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"

if [ -n "$old_current" ] && [ "$old_current" != "$release_dir" ]; then
  ln -sfn "$old_current" "$PREVIOUS_LINK.next"
  mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"
fi

restart_service() {
  if [ "$SKIP_RESTART" -eq 1 ]; then
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files talonbot.service >/dev/null 2>&1; then
    systemctl restart talonbot.service
  fi
}

healthcheck() {
  local timeout_s
  timeout_s=$((HEALTHCHECK_TIMEOUT_MS / 1000))
  if [ "$timeout_s" -lt 5 ]; then
    timeout_s=5
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  local i
  for i in $(seq 1 "$timeout_s"); do
    if curl -fsS "$HEALTHCHECK_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_service || true

if ! healthcheck; then
  echo "release health check failed: $HEALTHCHECK_URL"
  if [ -n "$old_current" ] && [ -d "$old_current" ]; then
    ln -sfn "$old_current" "$CURRENT_LINK.next"
    mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
    if [ -n "$old_previous" ] && [ -d "$old_previous" ]; then
      ln -sfn "$old_previous" "$PREVIOUS_LINK.next"
      mv -Tf "$PREVIOUS_LINK.next" "$PREVIOUS_LINK"
    fi
    restart_service || true
    echo "rolled back to previous release: $old_current"
  fi
  exit 1
fi

echo "release activated: $sha"
