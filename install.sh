#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
INSTALL_SERVICE=0
OVERWRITE_ENV=0
START_LOCAL=0

if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
  echo "❌ Node.js/npm are required. Install Node >=20 first."
  exit 1
fi

NODE_MAJOR="$(node -v | tr -d 'v' | cut -d. -f1)"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node 20+ is required. Current version: $(node -v)"
  exit 1
fi

usage() {
  echo "Usage: ./install.sh [--daemon] [--force-env] [--start]"
  echo
  echo "  --daemon     Install + enable a systemd service for production use."
  echo "  --force-env  Regenerate .env even if it already exists."
  echo "  --start      Start in foreground after build (non-daemon mode)."
  echo
  echo "Environment defaults can be customized before running this script:"
  echo "  ENGINE_MODE=mock|process, ENGINE_COMMAND, CONTROL_HTTP_PORT, SLACK_ENABLED, DISCORD_ENABLED, etc."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --daemon)
      INSTALL_SERVICE=1
      shift
      ;;
    --force-env)
      OVERWRITE_ENV=1
      shift
      ;;
    --start)
      START_LOCAL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

run_as_user="${SUDO_USER:-$(id -un)}"
run_as_home="$(getent passwd "$run_as_user" | cut -d: -f6)"

if [ -z "$run_as_home" ]; then
  run_as_home="$HOME"
fi

resolve_env() {
  printf '%s' "${1:-}"
}

write_env() {
  if [ -f "$ENV_FILE" ] && [ "$OVERWRITE_ENV" -ne 1 ]; then
    echo "Using existing .env at $ENV_FILE"
    return
  fi

  DATA_DIR="$(resolve_env "${DATA_DIR:-$run_as_home/.local/share/talonbot}")"
  CONTROL_SOCKET_PATH="$(resolve_env "${CONTROL_SOCKET_PATH:-$DATA_DIR/control.sock}")"
  ENGINE_MODE="$(resolve_env "${ENGINE_MODE:-mock}")"
  ENGINE_COMMAND="$(resolve_env "${ENGINE_COMMAND:-}")"
  ENGINE_ARGS="$(resolve_env "${ENGINE_ARGS:-}")"

  cat <<EOF > "$ENV_FILE"
NODE_ENV=production
LOG_LEVEL=info
DATA_DIR=$DATA_DIR
SESSION_MAX_MESSAGES=500
SESSION_TTL_SECONDS=3600
SESSION_DEDUPE_WINDOW_MS=30000
CONTROL_HTTP_PORT=${CONTROL_HTTP_PORT:-8080}
CONTROL_AUTH_TOKEN=${CONTROL_AUTH_TOKEN:-}
CONTROL_SOCKET_PATH=$CONTROL_SOCKET_PATH

MAX_QUEUE_PER_SESSION=16
MAX_MESSAGE_BYTES=12000

ENGINE_MODE=$ENGINE_MODE
ENGINE_COMMAND=$ENGINE_COMMAND
ENGINE_ARGS=$ENGINE_ARGS
ENGINE_TIMEOUT_MS=${ENGINE_TIMEOUT_MS:-120000}

SLACK_ENABLED=${SLACK_ENABLED:-false}
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN:-}
SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET:-}
SLACK_ALLOWED_CHANNELS=${SLACK_ALLOWED_CHANNELS:-}
SLACK_ALLOWED_CHANNEL_PREFIXES=${SLACK_ALLOWED_CHANNEL_PREFIXES:-}
SLACK_ALLOWED_USERS=${SLACK_ALLOWED_USERS:-}

DISCORD_ENABLED=${DISCORD_ENABLED:-false}
DISCORD_TOKEN=${DISCORD_TOKEN:-}
DISCORD_ALLOWED_CHANNELS=${DISCORD_ALLOWED_CHANNELS:-}
DISCORD_ALLOWED_GUILDS=${DISCORD_ALLOWED_GUILDS:-}
DISCORD_ALLOWED_USERS=${DISCORD_ALLOWED_USERS:-}
EOF

  echo "Generated .env at $ENV_FILE"
}

cd "$ROOT_DIR"
write_env

echo "Installing node dependencies..."
$NPM_BIN install

echo "Building runtime..."
$NPM_BIN run build

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "❌ systemctl not found. --daemon requires a systemd host."
    exit 1
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "❌ sudo is required for --daemon."
    exit 1
  fi

  SERVICE_USER="${SERVICE_USER:-$run_as_user}"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "❌ service user '$SERVICE_USER' does not exist"
    exit 1
  fi

  sudo chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE" 2>/dev/null || true
  sudo chmod 600 "$ENV_FILE"

  SERVICE_FILE="$(mktemp)"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=talonbot (always-on software-engineer agent)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $ROOT_DIR/dist/index.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

  sudo install -m 0644 "$SERVICE_FILE" /etc/systemd/system/talonbot.service
  rm -f "$SERVICE_FILE"

  sudo systemctl daemon-reload
  sudo systemctl enable --now talonbot.service

  echo
  echo "Service installed and started:"
  echo "  sudo systemctl status talonbot.service"
  echo "  sudo journalctl -u talonbot.service -f"
  exit 0
fi

if [ "$START_LOCAL" -eq 1 ]; then
  echo "Starting in foreground..."
  node dist/index.js
fi

echo
echo "Setup complete."
echo "Run:"
echo "  npm run start"
echo "or"
echo "  ./install.sh --start"
