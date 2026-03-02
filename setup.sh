#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
EXPERIMENTAL=0
RUNTIME_USER="talonbot"
ADMIN_USER=""

usage() {
  echo "Usage: $0 [--dry-run] [--experimental] [--runtime-user <user>] <admin_user>"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --experimental)
      EXPERIMENTAL=1
      shift
      ;;
    --runtime-user)
      if [ "$#" -lt 2 ]; then
        echo "--runtime-user requires a value"
        exit 1
      fi
      RUNTIME_USER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$ADMIN_USER" ]; then
        usage
        exit 1
      fi
      ADMIN_USER="$1"
      shift
      ;;
  esac
done

if [ -z "$ADMIN_USER" ]; then
  usage
  exit 1
fi

if [ "$DRY_RUN" -ne 1 ] && [ "$(id -u)" -ne 0 ]; then
  echo "setup.sh requires root (or use --dry-run)."
  exit 1
fi

if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  echo "admin user '$ADMIN_USER' does not exist"
  exit 1
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@"
}

echo "==> talonbot host setup"
echo "admin user: $ADMIN_USER"
echo "runtime user: $RUNTIME_USER"
[ "$EXPERIMENTAL" -eq 1 ] && echo "experimental mode: enabled"

if ! id "$RUNTIME_USER" >/dev/null 2>&1; then
  run useradd -m -s /bin/bash "$RUNTIME_USER"
fi

run usermod -aG "$RUNTIME_USER" "$ADMIN_USER"

run mkdir -p /opt/talonbot/releases
run mkdir -p /var/lib/talonbot
run mkdir -p /etc/talonbot

run chown -R "$RUNTIME_USER:$RUNTIME_USER" /var/lib/talonbot
run chown -R "$RUNTIME_USER:$RUNTIME_USER" /opt/talonbot
run chmod 750 /opt/talonbot /opt/talonbot/releases
run chmod 750 /var/lib/talonbot
run chmod 750 /etc/talonbot

install_wrapper() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$src" ]; then
    return 0
  fi
  run install -m 0755 "$src" "$dst"
}

install_wrapper "$ROOT_DIR/bin/talonbot" /usr/local/bin/talonbot
install_wrapper "$ROOT_DIR/bin/talonbot-safe-bash" /usr/local/bin/talonbot-safe-bash
install_wrapper "$ROOT_DIR/bin/security-audit.sh" /usr/local/bin/talonbot-security-audit
install_wrapper "$ROOT_DIR/bin/setup-firewall.sh" /usr/local/bin/talonbot-setup-firewall
install_wrapper "$ROOT_DIR/bin/update-release.sh" /usr/local/bin/talonbot-update-release
install_wrapper "$ROOT_DIR/bin/rollback-release.sh" /usr/local/bin/talonbot-rollback-release
install_wrapper "$ROOT_DIR/bin/uninstall.sh" /usr/local/bin/talonbot-uninstall

if [ -f "$ROOT_DIR/systemd/talonbot.service" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] install systemd unit /etc/systemd/system/talonbot.service"
  else
    tmp_unit="$(mktemp)"
    sed \
      -e "s/^User=.*/User=$RUNTIME_USER/" \
      -e "s/^Group=.*/Group=$RUNTIME_USER/" \
      "$ROOT_DIR/systemd/talonbot.service" > "$tmp_unit"
    install -m 0644 "$tmp_unit" /etc/systemd/system/talonbot.service
    rm -f "$tmp_unit"

    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload
    fi
  fi
fi

if [ -x "$ROOT_DIR/bin/setup-firewall.sh" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    run "$ROOT_DIR/bin/setup-firewall.sh" --dry-run
  else
    run "$ROOT_DIR/bin/setup-firewall.sh"
  fi
fi

echo "==> setup complete"
