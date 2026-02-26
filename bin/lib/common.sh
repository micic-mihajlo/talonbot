#!/usr/bin/env bash
set -euo pipefail

bb_now_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

bb_hash_file() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
    return 0
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$target" | awk '{print $NF}'
    return 0
  fi

  echo "missing-hash-tool"
  return 1
}

bb_realpath() {
  local target="$1"
  node -e 'const fs=require("fs"); try { console.log(fs.realpathSync(process.argv[1])); } catch { process.exit(1); }' "$target"
}

bb_env_bool() {
  local value="${1:-}"
  case "${value,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

bb_json_escape() {
  node -e 'console.log(JSON.stringify(process.argv[1] || "").slice(1,-1))' "$1"
}
