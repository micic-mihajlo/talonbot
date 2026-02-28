#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_root="$(mktemp -d /tmp/talonbot-bootstrap-smoke-XXXXXX)"
home_dir="$tmp_root/home"
bootstrap_repo="$tmp_root/bootstrap-repo"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

mkdir -p "$home_dir"
mkdir -p "$bootstrap_repo"

tar -C "$repo_root" --exclude='.git' --exclude='node_modules' -cf - . | tar -C "$bootstrap_repo" -xf -
git -C "$bootstrap_repo" init -q
git -C "$bootstrap_repo" checkout -q -b main
git -C "$bootstrap_repo" add -A
git -C "$bootstrap_repo" -c user.name='talonbot-ci' -c user.email='ci@talonbot.local' commit -q -m 'bootstrap smoke snapshot'

export HOME="$home_dir"
export PATH="$HOME/.local/bin:$PATH"
export TALONBOT_BOOTSTRAP_REPO="$bootstrap_repo"
export TALONBOT_BOOTSTRAP_REF="main"
export NPM_CONFIG_AUDIT="false"
export NPM_CONFIG_FUND="false"

bash "$repo_root/bootstrap.sh"

if [ ! -x "$HOME/.local/bin/talonbot" ]; then
  echo "bootstrap smoke failed: talonbot wrapper missing"
  exit 1
fi

"$HOME/.local/bin/talonbot" install --non-interactive --skip-deps --skip-build
"$HOME/.local/bin/talonbot" install --non-interactive --skip-deps --skip-build

env_file="$HOME/.talonbot/src/.env"
if [ ! -f "$env_file" ]; then
  echo "bootstrap smoke failed: .env not created"
  exit 1
fi

token="$(awk -F= '$1=="CONTROL_AUTH_TOKEN" {print substr($0, index($0, "=")+1)}' "$env_file" | tail -n 1)"
if [ -z "$token" ]; then
  echo "bootstrap smoke failed: CONTROL_AUTH_TOKEN was not generated"
  exit 1
fi

echo "bootstrap/install smoke: ok"
