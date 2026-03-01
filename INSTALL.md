# Installation Notes

## 3-command quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/micic-mihajlo/talonbot/main/bootstrap.sh | bash
talonbot install
npm run start
```

Bootstrap installs:

- source at `~/.talonbot/src`
- CLI wrapper at `~/.local/bin/talonbot`

Install behavior (`talonbot install`):

- idempotent (safe to rerun)
- creates `.env` when missing
- generates `CONTROL_AUTH_TOKEN` when missing
- installs dependencies + builds runtime
- supports non-interactive usage (`--non-interactive` / `--yes`)

## Common install flags

```bash
talonbot install --doctor
talonbot install --start
talonbot install --daemon --doctor
talonbot install --token your-long-random-token
talonbot install --generate-token
```

## Linux daemon setup (systemd)

```bash
talonbot install --daemon --doctor
```

This installs `/etc/systemd/system/talonbot.service`, enables it, and starts it.

Check service:

```bash
sudo systemctl status talonbot.service
sudo journalctl -u talonbot.service -f
talonbot status --api
talonbot operator
```

## Linux VPS step-by-step (process engine with `pi`)

1. Prepare host packages:

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential tmux jq
```

2. Install Node 20+ (or newer) and verify:

```bash
node -v
npm -v
```

3. Bootstrap and install:

```bash
curl -fsSL https://raw.githubusercontent.com/micic-mihajlo/talonbot/main/bootstrap.sh | bash
talonbot install --daemon --doctor
```

4. Install `pi` for the same runtime user:

```bash
npm install -g @mariozechner/pi-coding-agent
which pi
pi --version
```

5. Configure `.env` engine settings:

```bash
talonbot env set ENGINE_MODE process
talonbot env set ENGINE_COMMAND "$(command -v pi)"
talonbot env set ENGINE_ARGS "-p --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools"
talonbot env set PI_SKIP_VERSION_CHECK 1
talonbot env set ENGINE_CWD "/var/lib/talonbot/engine"
talonbot env set CONTROL_HTTP_PORT 8080
```

6. Complete `pi` auth once as the service user, then restart:

```bash
pi -p "auth smoke check"
sudo systemctl restart talonbot.service
```

7. Verify runtime:

```bash
talonbot status --api
talonbot operator
curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/health | jq
curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/workers | jq
npm run doctor -- --strict --runtime-url http://127.0.0.1:8080 --runtime-token "$CONTROL_AUTH_TOKEN"
```

## Troubleshooting

If `talonbot` is not found after bootstrap:

- add `~/.local/bin` to your shell profile `PATH`
- rerun bootstrap

If install fails on Node version:

- `talonbot` requires Node.js 20+
- verify with `node -v`

If service setup fails:

1. `npm run doctor -- --strict`
2. `talonbot status --api`
3. `sudo journalctl -u talonbot.service -f`
