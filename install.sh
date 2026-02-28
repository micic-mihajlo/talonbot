#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
INSTALL_SERVICE=0
OVERWRITE_ENV=0
START_LOCAL=0
RUN_DOCTOR=0

log_info() {
  echo "[install] $*"
}

log_warn() {
  echo "[install][warn] $*"
}

log_error() {
  echo "[install][error] $*" >&2
}

if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
  log_error "Node.js and npm are required (Node >=20)."
  log_error "Install Node, then rerun ./install.sh."
  exit 1
fi

NODE_MAJOR="$(node -v | tr -d 'v' | cut -d. -f1)"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt 20 ]; then
  log_error "Node 20+ is required. Current version: $(node -v)"
  exit 1
fi

usage() {
  echo "Usage: ./install.sh [--daemon] [--force-env] [--start] [--doctor]"
  echo
  echo "  --daemon     Install + enable a systemd service for production use."
  echo "  --force-env  Regenerate .env even if it already exists."
  echo "  --start      Start in foreground after build (non-daemon mode)."
  echo "  --doctor     Run doctor checks after install/build (and runtime checks in daemon mode)."
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
    --doctor)
      RUN_DOCTOR=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

run_as_user="${SUDO_USER:-$(id -un)}"
run_as_home="$(getent passwd "$run_as_user" | cut -d: -f6 || true)"

if [ -z "$run_as_home" ]; then
  run_as_home="$HOME"
fi

resolve_env() {
  printf '%s' "${1:-}"
}

write_env() {
  if [ -f "$ENV_FILE" ] && [ "$OVERWRITE_ENV" -ne 1 ]; then
    log_info "Using existing .env at $ENV_FILE"
    return
  fi

  DATA_DIR="$(resolve_env "${DATA_DIR:-$run_as_home/.local/share/talonbot}")"
  CONTROL_SOCKET_PATH="$(resolve_env "${CONTROL_SOCKET_PATH:-$DATA_DIR/control.sock}")"
  ENGINE_MODE="$(resolve_env "${ENGINE_MODE:-mock}")"
  ENGINE_COMMAND="$(resolve_env "${ENGINE_COMMAND:-}")"
  ENGINE_ARGS="$(resolve_env "${ENGINE_ARGS:-}")"
  ENGINE_CWD="$(resolve_env "${ENGINE_CWD:-$DATA_DIR/engine}")"

  cat <<ENV_EOF > "$ENV_FILE"
NODE_ENV=production
LOG_LEVEL=info
DATA_DIR=$DATA_DIR
SESSION_MAX_MESSAGES=500
SESSION_TTL_SECONDS=3600
SESSION_DEDUPE_WINDOW_MS=30000
CONTROL_HTTP_PORT=${CONTROL_HTTP_PORT:-8080}
CONTROL_AUTH_TOKEN=${CONTROL_AUTH_TOKEN:-}
CONTROL_SOCKET_PATH=$CONTROL_SOCKET_PATH
TALONBOT_SECRET_ALLOW_COMMAND=${TALONBOT_SECRET_ALLOW_COMMAND:-false}
TALONBOT_SECRET_COMMAND_TIMEOUT_MS=${TALONBOT_SECRET_COMMAND_TIMEOUT_MS:-3000}
TALONBOT_SECRET_MAX_BYTES=${TALONBOT_SECRET_MAX_BYTES:-8192}

MAX_QUEUE_PER_SESSION=16
MAX_MESSAGE_BYTES=12000

ENGINE_MODE=$ENGINE_MODE
ENGINE_COMMAND=$ENGINE_COMMAND
ENGINE_ARGS=$ENGINE_ARGS
ENGINE_CWD=$ENGINE_CWD
ENGINE_TIMEOUT_MS=${ENGINE_TIMEOUT_MS:-120000}

REPO_ROOT_DIR=${REPO_ROOT_DIR:-$run_as_home/workspace}
WORKTREE_ROOT_DIR=${WORKTREE_ROOT_DIR:-$run_as_home/workspace/worktrees}
RELEASE_ROOT_DIR=${RELEASE_ROOT_DIR:-$run_as_home/.local/share/talonbot/releases}
TASK_MAX_CONCURRENCY=${TASK_MAX_CONCURRENCY:-3}
WORKER_MAX_RETRIES=${WORKER_MAX_RETRIES:-2}
WORKTREE_STALE_HOURS=${WORKTREE_STALE_HOURS:-24}
TASK_AUTOCLEANUP=${TASK_AUTOCLEANUP:-true}
TASK_AUTO_COMMIT=${TASK_AUTO_COMMIT:-false}
TASK_AUTO_PR=${TASK_AUTO_PR:-false}
STARTUP_INTEGRITY_MODE=${STARTUP_INTEGRITY_MODE:-warn}
SESSION_LOG_RETENTION_DAYS=${SESSION_LOG_RETENTION_DAYS:-14}
ENABLE_WEBHOOK_BRIDGE=${ENABLE_WEBHOOK_BRIDGE:-true}
BRIDGE_SHARED_SECRET=${BRIDGE_SHARED_SECRET:-}
BRIDGE_RETRY_BASE_MS=${BRIDGE_RETRY_BASE_MS:-2000}
BRIDGE_RETRY_MAX_MS=${BRIDGE_RETRY_MAX_MS:-30000}
BRIDGE_MAX_RETRIES=${BRIDGE_MAX_RETRIES:-5}
BRIDGE_STATE_FILE=${BRIDGE_STATE_FILE:-$DATA_DIR/bridge/state.json}

SLACK_ENABLED=${SLACK_ENABLED:-false}
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
SLACK_APP_TOKEN=${SLACK_APP_TOKEN:-}
SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET:-}
SLACK_ALLOWED_CHANNELS=${SLACK_ALLOWED_CHANNELS:-}
SLACK_ALLOWED_CHANNEL_PREFIXES=${SLACK_ALLOWED_CHANNEL_PREFIXES:-}
SLACK_ALLOWED_USERS=${SLACK_ALLOWED_USERS:-}

DISCORD_ENABLED=${DISCORD_ENABLED:-false}
DISCORD_TOKEN=${DISCORD_TOKEN:-}
DISCORD_TYPING_ENABLED=${DISCORD_TYPING_ENABLED:-true}
DISCORD_REACTIONS_ENABLED=${DISCORD_REACTIONS_ENABLED:-true}
DISCORD_ALLOWED_CHANNELS=${DISCORD_ALLOWED_CHANNELS:-}
DISCORD_ALLOWED_GUILDS=${DISCORD_ALLOWED_GUILDS:-}
DISCORD_ALLOWED_USERS=${DISCORD_ALLOWED_USERS:-}
ENV_EOF

  log_info "Generated .env at $ENV_FILE"
}

read_env_value() {
  local key="$1"
  local value
  value="$(awk -F= -v k="$key" '$1==k {print substr($0, index($0, "=") + 1)}' "$ENV_FILE" | tail -n 1)"
  printf '%s' "$value"
}

run_doctor_checks() {
  local mode="$1"
  local runtime_port
  local runtime_token

  log_info "Running doctor checks..."
  if ! "$NPM_BIN" run doctor; then
    log_warn "doctor reported issues. Review output and fix before production rollout."
  fi

  if [ "$mode" = "daemon" ]; then
    runtime_port="$(read_env_value CONTROL_HTTP_PORT)"
    runtime_token="$(read_env_value CONTROL_AUTH_TOKEN)"
    if [ -z "$runtime_port" ]; then
      runtime_port="8080"
    fi

    if [ -n "$runtime_token" ]; then
      if ! "$NPM_BIN" run doctor -- --runtime-url "http://127.0.0.1:$runtime_port" --runtime-token "$runtime_token"; then
        log_warn "runtime doctor checks reported issues. Inspect `talonbot status` and service logs."
      fi
    else
      if ! "$NPM_BIN" run doctor -- --runtime-url "http://127.0.0.1:$runtime_port"; then
        log_warn "runtime doctor checks reported issues. Set CONTROL_AUTH_TOKEN and rerun doctor for full auth checks."
      fi
    fi
  fi
}

cd "$ROOT_DIR"
write_env

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  if [ -z "$(read_env_value CONTROL_AUTH_TOKEN)" ]; then
    log_warn "CONTROL_AUTH_TOKEN is empty; control endpoints will be unauthenticated."
    log_warn "Set CONTROL_AUTH_TOKEN in $ENV_FILE before exposing control API beyond localhost."
  fi
fi

log_info "Installing node dependencies..."
"$NPM_BIN" install

log_info "Building runtime..."
"$NPM_BIN" run build

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    log_error "systemctl not found. --daemon requires a systemd host."
    exit 1
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    log_error "sudo is required for --daemon."
    exit 1
  fi

  SERVICE_USER="${SERVICE_USER:-$run_as_user}"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log_error "service user '$SERVICE_USER' does not exist"
    exit 1
  fi

  log_info "Installing daemon service for user: $SERVICE_USER"

  sudo chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE" 2>/dev/null || true
  sudo chmod 600 "$ENV_FILE"

  SERVICE_FILE="$(mktemp)"
  cat > "$SERVICE_FILE" <<SERVICE_EOF
[Unit]
Description=talonbot (always-on software-engineer agent)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
ExecStartPre=/usr/bin/env bash $ROOT_DIR/bin/harden-permissions.sh
ExecStartPre=/usr/bin/env bash $ROOT_DIR/bin/verify-manifest.sh
ExecStart=$NODE_BIN $ROOT_DIR/dist/index.js
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectControlGroups=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectSystem=full
ReadWritePaths=/var/lib/talonbot /home/$SERVICE_USER/.local/share/talonbot /home/$SERVICE_USER/workspace $ENV_FILE

[Install]
WantedBy=multi-user.target
SERVICE_EOF

  sudo install -m 0644 "$SERVICE_FILE" /etc/systemd/system/talonbot.service
  rm -f "$SERVICE_FILE"

  if [ -f "$ROOT_DIR/bin/talonbot" ]; then
    sudo install -m 0755 "$ROOT_DIR/bin/talonbot" /usr/local/bin/talonbot
  fi
  if [ -f "$ROOT_DIR/bin/talonbot-safe-bash" ]; then
    sudo install -m 0755 "$ROOT_DIR/bin/talonbot-safe-bash" /usr/local/bin/talonbot-safe-bash
  fi
  if [ -f "$ROOT_DIR/bin/security-audit.sh" ]; then
    sudo install -m 0755 "$ROOT_DIR/bin/security-audit.sh" /usr/local/bin/talonbot-security-audit
  fi
  if [ -f "$ROOT_DIR/bin/setup-firewall.sh" ]; then
    sudo install -m 0755 "$ROOT_DIR/bin/setup-firewall.sh" /usr/local/bin/talonbot-setup-firewall
  fi
  if [ -f "$ROOT_DIR/bin/uninstall.sh" ]; then
    sudo install -m 0755 "$ROOT_DIR/bin/uninstall.sh" /usr/local/bin/talonbot-uninstall
  fi

  sudo systemctl daemon-reload
  sudo systemctl enable --now talonbot.service

  if [ "$RUN_DOCTOR" -eq 1 ]; then
    run_doctor_checks "daemon"
  fi

  port_display="$(read_env_value CONTROL_HTTP_PORT)"
  if [ -z "$port_display" ]; then
    port_display="8080"
  fi

  echo
  echo "Service installed and started."
  echo "Quick checks:"
  echo "  sudo systemctl status talonbot.service"
  echo "  sudo journalctl -u talonbot.service -f"
  echo "  talonbot status --api"
  echo "  talonbot operator"
  echo "  npm run doctor -- --strict --runtime-url http://127.0.0.1:$port_display"
  exit 0
fi

if [ "$RUN_DOCTOR" -eq 1 ]; then
  run_doctor_checks "local"
fi

if [ "$START_LOCAL" -eq 1 ]; then
  log_info "Starting in foreground..."
  node dist/index.js
fi

echo
echo "Setup complete."
echo "Run:"
echo "  npm run start"
echo "or"
echo "  ./install.sh --start"
echo "Optional checks:"
echo "  npm run doctor"
echo "  npm run cli -- operator"
