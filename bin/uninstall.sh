#!/usr/bin/env bash
set -euo pipefail

PURGE=0
if [ "${1:-}" = "--purge" ]; then
  PURGE=1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "uninstall: run as root"
  exit 1
fi

systemctl disable --now talonbot.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/talonbot.service
systemctl daemon-reload >/dev/null 2>&1 || true
rm -f /usr/local/bin/talonbot

if [ "$PURGE" -eq 1 ]; then
  target_user="${SUDO_USER:-}"
  if [ -n "$target_user" ]; then
    home_dir=$(getent passwd "$target_user" | cut -d: -f6)
    rm -rf "$home_dir/.local/share/talonbot" "$home_dir/workspace/worktrees"
  fi
fi

echo "uninstall: complete"
