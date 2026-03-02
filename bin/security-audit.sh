#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEEP=0
if [ "${1:-}" = "--deep" ]; then
  DEEP=1
fi

DATA_DIR="${DATA_DIR:-/var/lib/talonbot}"
CONFIG_FILE="${CONFIG_FILE:-/etc/talonbot/talonbot.env}"
if [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="${CONFIG_FILE_FALLBACK:-$HOME/.config/.env}"
fi

FINDINGS=0
ERRORS=0

pass() { echo "PASS: $1"; }
warn() { echo "WARN: $1"; FINDINGS=$((FINDINGS + 1)); }
fail() { echo "FAIL: $1"; FINDINGS=$((FINDINGS + 1)); ERRORS=$((ERRORS + 1)); }

env_get() {
  local key="$1"
  if [ ! -f "$CONFIG_FILE" ]; then
    printf ''
    return
  fi
  awk -F= -v k="$key" '$1==k {print substr($0, index($0, "=")+1)}' "$CONFIG_FILE" | tail -n1
}

runtime_user="${RUNTIME_EXPECTED_USER:-$(env_get RUNTIME_EXPECTED_USER)}"
runtime_user="${runtime_user:-talonbot}"

if [ "$(id -u)" -eq 0 ]; then
  warn "audit running as root; regular runtime should be non-root"
else
  pass "audit running as non-root user"
fi

if [ -f "$CONFIG_FILE" ]; then
  token_len="$(env_get CONTROL_AUTH_TOKEN | awk '{print length}')"
  if [ -z "$token_len" ] || [ "$token_len" -lt 24 ]; then
    fail "CONTROL_AUTH_TOKEN missing or too short in $CONFIG_FILE"
  else
    pass "CONTROL_AUTH_TOKEN length looks safe"
  fi
else
  fail "config file missing: $CONFIG_FILE"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files talonbot.service >/dev/null 2>&1; then
  service_user="$(systemctl show -p User --value talonbot.service 2>/dev/null || true)"
  if [ -z "$service_user" ]; then
    fail "unable to read talonbot.service User property"
  elif [ "$service_user" != "$runtime_user" ]; then
    fail "service user mismatch (expected $runtime_user, got $service_user)"
  elif [ "$service_user" = "root" ]; then
    fail "talonbot.service configured to run as root"
  else
    pass "talonbot.service runs as expected runtime user ($service_user)"
  fi

  hardened_fields=(NoNewPrivileges ProtectSystem ProtectKernelTunables ProtectKernelModules PrivateTmp)
  for field in "${hardened_fields[@]}"; do
    value="$(systemctl show -p "$field" --value talonbot.service 2>/dev/null || true)"
    if [ "$value" = "yes" ] || [ "$field" = "ProtectSystem" -a "$value" = "full" ]; then
      pass "systemd hardening $field=$value"
    else
      warn "systemd hardening $field is not fully enabled (value='$value')"
    fi
  done
else
  warn "systemd talonbot.service not found; skipping service isolation checks"
fi

if "$SCRIPT_DIR/verify-manifest.sh"; then
  pass "manifest verification completed"
else
  fail "manifest verification failed"
fi

state_files=(
  "$DATA_DIR/tasks/state.json"
  "$DATA_DIR/bridge/state.json"
  "$DATA_DIR/transports/outbox.json.discord"
  "$DATA_DIR/transports/outbox.json.slack"
)

for file in "${state_files[@]}"; do
  if [ ! -e "$file" ]; then
    continue
  fi

  mode="$(stat -c '%a' "$file" 2>/dev/null || true)"
  owner="$(stat -c '%U' "$file" 2>/dev/null || true)"

  if [ -n "$mode" ]; then
    mode_bits=$((8#$mode))
    other_bits=$((mode_bits & 7))
    group_write=$((mode_bits & 16))
    if [ "$other_bits" -gt 0 ] || [ "$group_write" -gt 0 ]; then
      warn "state file has broad permissions ($file mode=$mode)"
    else
      pass "state file permissions look safe ($file mode=${mode:-unknown})"
    fi
  else
    warn "unable to determine permissions for state file ($file)"
  fi

  if [ -n "$owner" ] && [ "$owner" != "$runtime_user" ]; then
    warn "state file owner mismatch ($file owner=$owner expected=$runtime_user)"
  fi
done

"$SCRIPT_DIR/prune-session-logs.sh" "${SESSION_LOG_RETENTION_DAYS:-14}" >/dev/null 2>&1 || warn "log pruning encountered issues"

if [ -d "$DATA_DIR/sessions" ]; then
  leaks=$(find "$DATA_DIR/sessions" -type f -name '*.jsonl' -exec grep -E -l '(sk-[A-Za-z0-9_\-]{12,}|xox[baprs]-|ghp_[A-Za-z0-9]{30,}|xapp-)' {} + 2>/dev/null || true)
  if [ -n "$leaks" ]; then
    warn "possible secrets detected in session logs; running redaction"
    "$SCRIPT_DIR/redact-logs.sh" >/dev/null 2>&1 || warn "redaction failed"
  else
    pass "no obvious secrets detected in session logs"
  fi
fi

"$SCRIPT_DIR/harden-permissions.sh" >/dev/null 2>&1 || warn "permission hardening encountered issues"

if [ "$DEEP" -eq 1 ]; then
  pattern='(eval\s*\(|new\s+Function\s*\(|child_process\.(exec|execSync)|curl\s+.*\|\s*(bash|sh)|docker\s+run\s+--privileged)'
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
