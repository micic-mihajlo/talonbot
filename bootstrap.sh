#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

REPO_URL="${TALONBOT_BOOTSTRAP_REPO:-https://github.com/micic-mihajlo/talonbot.git}"
REPO_REF="${TALONBOT_BOOTSTRAP_REF:-main}"
TALONBOT_HOME="${TALONBOT_HOME:-$HOME/.talonbot}"
SRC_DIR="${TALONBOT_SRC_DIR:-$TALONBOT_HOME/src}"
BIN_DIR="${TALONBOT_BIN_DIR:-$HOME/.local/bin}"
WRAPPER_PATH="$BIN_DIR/talonbot"

log_info() {
  echo "[bootstrap] $*"
}

log_warn() {
  echo "[bootstrap][warn] $*"
}

log_error() {
  echo "[bootstrap][error] $*" >&2
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "Required command not found: $cmd"
    exit 1
  fi
}

check_node_version() {
  local major
  major="$(node -v | tr -d 'v' | cut -d. -f1)"
  if ! [[ "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt 20 ]; then
    log_error "Node.js 20+ is required (found $(node -v))."
    exit 1
  fi
}

checkout_ref() {
  if [ -z "$REPO_REF" ]; then
    return
  fi

  if git -C "$SRC_DIR" rev-parse --verify --quiet "$REPO_REF" >/dev/null; then
    git -C "$SRC_DIR" checkout -q "$REPO_REF"
    return
  fi

  git -C "$SRC_DIR" fetch origin "$REPO_REF" --depth=1
  git -C "$SRC_DIR" checkout -q FETCH_HEAD
}

clone_or_update_repo() {
  mkdir -p "$TALONBOT_HOME"

  if [ -d "$SRC_DIR/.git" ]; then
    log_info "Updating existing checkout in $SRC_DIR"

    if [ -n "$(git -C "$SRC_DIR" status --porcelain)" ]; then
      log_warn "Local changes detected in $SRC_DIR; skipping git update to avoid clobbering edits."
      return
    fi

    if ! git -C "$SRC_DIR" fetch origin "$REPO_REF" --depth=1; then
      log_warn "Failed to fetch origin/$REPO_REF; leaving existing checkout unchanged."
      return
    fi

    checkout_ref

    if git -C "$SRC_DIR" rev-parse --verify --quiet "origin/$REPO_REF" >/dev/null; then
      git -C "$SRC_DIR" merge --ff-only "origin/$REPO_REF" >/dev/null
    fi
    return
  fi

  if [ -e "$SRC_DIR" ]; then
    log_error "$SRC_DIR exists but is not a git checkout. Move/remove it and retry."
    exit 1
  fi

  log_info "Cloning $REPO_URL ($REPO_REF) into $SRC_DIR"
  git clone "$REPO_URL" "$SRC_DIR"
  checkout_ref
}

install_wrapper() {
  mkdir -p "$BIN_DIR"

  cat > "$WRAPPER_PATH" <<'WRAP_EOF'
#!/usr/bin/env bash
set -euo pipefail

TALONBOT_HOME="${TALONBOT_HOME:-$HOME/.talonbot}"
TALONBOT_SRC_DIR="${TALONBOT_SRC_DIR:-$TALONBOT_HOME/src}"
ENTRYPOINT="$TALONBOT_SRC_DIR/bin/talonbot"

if [ ! -x "$ENTRYPOINT" ]; then
  echo "talonbot: missing $ENTRYPOINT; rerun bootstrap." >&2
  exit 1
fi

exec "$ENTRYPOINT" "$@"
WRAP_EOF

  chmod 0755 "$WRAPPER_PATH"
}

require_cmd bash
require_cmd git
require_cmd node
require_cmd npm
check_node_version

clone_or_update_repo
install_wrapper

if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  log_warn "$BIN_DIR is not in PATH for this shell."
  log_warn "Add this line to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
fi

echo
echo "Bootstrap complete."
echo "- Source: $SRC_DIR"
echo "- CLI: $WRAPPER_PATH"
echo
echo "Next steps:"
echo "  talonbot install"
echo "  talonbot status --api"
echo
echo "For a systemd daemon on Linux:"
echo "  talonbot install --daemon --doctor"
