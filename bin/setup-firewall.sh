#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

SSH_PORT="${SSH_PORT:-22}"
ALLOW_HTTP="${ALLOW_HTTP:-true}"
ALLOW_HTTPS="${ALLOW_HTTPS:-true}"

print_plan() {
  cat <<PLAN
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -p tcp --dport $SSH_PORT -j ACCEPT
PLAN

  if [ "$ALLOW_HTTP" = "true" ]; then
    echo "iptables -A INPUT -p tcp --dport 80 -j ACCEPT"
  fi
  if [ "$ALLOW_HTTPS" = "true" ]; then
    echo "iptables -A INPUT -p tcp --dport 443 -j ACCEPT"
  fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  print_plan
  echo "setup-firewall: dry-run"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "setup-firewall: requires root unless --dry-run"
  exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "setup-firewall: iptables command not found"
  exit 1
fi

ensure_policy() {
  local chain="$1"
  local policy="$2"
  local current
  current="$(iptables -S | awk -v chain="$chain" '$1=="-P" && $2==chain {print $3}' | head -n1)"
  if [ "$current" != "$policy" ]; then
    iptables -P "$chain" "$policy"
  fi
}

ensure_rule() {
  local chain="$1"
  shift
  if ! iptables -C "$chain" "$@" >/dev/null 2>&1; then
    iptables -A "$chain" "$@"
  fi
}

ensure_policy INPUT DROP
ensure_policy FORWARD DROP
ensure_policy OUTPUT ACCEPT

ensure_rule INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ensure_rule INPUT -i lo -j ACCEPT
ensure_rule INPUT -p tcp --dport "$SSH_PORT" -j ACCEPT

if [ "$ALLOW_HTTP" = "true" ]; then
  ensure_rule INPUT -p tcp --dport 80 -j ACCEPT
fi

if [ "$ALLOW_HTTPS" = "true" ]; then
  ensure_rule INPUT -p tcp --dport 443 -j ACCEPT
fi

echo "setup-firewall: applied"
