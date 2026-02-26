#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEEP=0
if [ "${1:-}" = "--deep" ]; then
  DEEP=1
fi

DATA_DIR="${DATA_DIR:-$HOME/.local/share/talonbot}"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.config/.env}"
FINDINGS=0
ERRORS=0

pass() { echo "PASS: $1"; }
warn() { echo "WARN: $1"; FINDINGS=$((FINDINGS + 1)); }
fail() { echo "FAIL: $1"; FINDINGS=$((FINDINGS + 1)); ERRORS=$((ERRORS + 1)); }

if [ "$(id -u)" -eq 0 ]; then
  warn "runtime process should not run as root"
else
  pass "running as non-root user"
fi

if [ -f "$CONFIG_FILE" ]; then
  token_len=$(grep -E '^CONTROL_AUTH_TOKEN=' "$CONFIG_FILE" | head -n1 | cut -d= -f2- | awk '{print length}' || echo 0)
  if [ "$token_len" -lt 24 ]; then
    fail "CONTROL_AUTH_TOKEN missing or too short in $CONFIG_FILE"
  else
    pass "CONTROL_AUTH_TOKEN length looks safe"
  fi
else
  fail "config file missing: $CONFIG_FILE"
fi

if "$SCRIPT_DIR/verify-manifest.sh"; then
  pass "manifest verification completed"
else
  fail "manifest verification failed in strict mode"
fi

"$SCRIPT_DIR/prune-session-logs.sh" "${SESSION_LOG_RETENTION_DAYS:-14}" >/dev/null || warn "log pruning encountered issues"

if [ -d "$DATA_DIR/sessions" ]; then
  secrets=$(find "$DATA_DIR/sessions" -type f -name '*.jsonl' -exec grep -E -l '(sk-[A-Za-z0-9_\-]{12,}|xox[baprs]-|ghp_[A-Za-z0-9]{30,}|xapp-)' {} + 2>/dev/null || true)
  if [ -n "$secrets" ]; then
    warn "secrets detected in session logs; applying redaction"
    "$SCRIPT_DIR/redact-logs.sh" >/dev/null
  else
    pass "no obvious secrets found in session logs"
  fi
fi

"$SCRIPT_DIR/harden-permissions.sh" >/dev/null || warn "permission hardening encountered issues"

if [ "$DEEP" -eq 1 ]; then
  pattern='(eval\s*\(|new\s+Function\s*\(|child_process\.execSync|curl\s+.*\|\s*bash)'
  matches=$(find src bin -type f \( -name '*.ts' -o -name '*.js' -o -name '*.sh' \) -exec grep -nE "$pattern" {} + 2>/dev/null || true)
  if [ -n "$matches" ]; then
    warn "deep scan found potentially risky patterns"
    echo "$matches"
  else
    pass "deep scan found no risky patterns"
  fi
fi

echo "audit summary: findings=$FINDINGS errors=$ERRORS"
[ "$ERRORS" -gt 0 ] && exit 1
exit 0
