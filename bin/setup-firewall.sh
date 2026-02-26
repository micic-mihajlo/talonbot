#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

if [ "$DRY_RUN" -ne 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo "setup-firewall: requires root unless --dry-run"
  exit 1
fi

run() {
  echo "$*"
  if [ "$DRY_RUN" -ne 1 ]; then
    eval "$*"
  fi
}

run "iptables -P INPUT DROP"
run "iptables -P FORWARD DROP"
run "iptables -P OUTPUT ACCEPT"
run "iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
run "iptables -A INPUT -i lo -j ACCEPT"
run "iptables -A INPUT -p tcp --dport 22 -j ACCEPT"
run "iptables -A INPUT -p tcp --dport 80 -j ACCEPT"
run "iptables -A INPUT -p tcp --dport 443 -j ACCEPT"

echo "setup-firewall: applied"
