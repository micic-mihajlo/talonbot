# Talonbot

`talonbot` is a Linux-first, always-on software-engineer agent runner with:

- Slack ingress (Socket Mode)
- Discord ingress
- Per-route session queues and persistent context
- Operator control surface (HTTP + Unix socket)
- Pluggable local execution engine (mock mode included)
- Multi-agent task orchestration with worker lifecycle state
- Optional sentry supervisor for escalations and incident tracking
- Repo registry + isolated git worktree execution pipeline
- Release snapshots with atomic activation + rollback
- Security audit, log redaction/retention, and diagnostics bundle generation

## Repository structure

- `src/shared/*` protocol contracts and transport-agnostic payloads
- `src/control/*` session and route orchestration
- `src/engine/*` pluggable execution strategy
- `src/transports/{slack,discord}` message ingress adapters
- `src/runtime/{http,socket}.ts` control interfaces

## Try it in 3 minutes (local, no API keys)

No Slack/Discord credentials required for this path. Use the built-in mock engine:

```bash
cd /path/to/talonbot
cp .env.example .env
./install.sh --doctor --start
```

This gives an immediate local control-plane at:

- Unix socket: `${CONTROL_SOCKET_PATH}` (default `~/.local/share/talonbot/control.sock`)
- HTTP control plane: port `8080` (set in `.env`)

If you want it as a long-running VPS service:

```bash
cd /path/to/talonbot
cp .env.example .env
./install.sh --daemon --doctor
```

This generates a dedicated `talonbot.service`, enables it, and starts it on boot.

## Discord-first quickstart

If Discord is your primary transport:

```bash
cd /path/to/talonbot
cp systemd/talonbot.env.template .env
# edit .env:
# DISCORD_ENABLED=true
# DISCORD_TOKEN=your-discord-bot-token
# CONTROL_AUTH_TOKEN=choose-a-long-random-string
./install.sh --start
```

Invite the bot with standard message permissions (`Read Messages`, `Send Messages`), then run:

```bash
curl -s http://localhost:8080/sessions
```

You should see active sessions appear once messages are received.

## Quick smoke checks

```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/status
curl -s http://localhost:8080/sessions
curl -s -H "Content-Type: application/json" -d '{"source":"discord","channelId":"local","text":"hello bot","senderId":"you"}' http://localhost:8080/dispatch
```

You should get an accepted response from `/dispatch` and a reply text in logs/JSON.

Run health/config sanity checks locally with:

```bash
npm run doctor
npm run cli -- operator
```

Enable one transport when you’re ready to connect real chat:

- `SLACK_ENABLED=true` plus Slack tokens
- `DISCORD_ENABLED=true` plus Discord token

## Control API

`CONTROL_HTTP_PORT` can be changed; default is `8080` in the template.

### Startup checks

- Strict config schema is validated before runtime init.
- Unknown keys in `.env` fail fast (override env file path with `TALONBOT_ENV_FILE`).
- `engine`: errors if `ENGINE_MODE=process` but `ENGINE_COMMAND` is empty.
- `slack`: errors if `SLACK_ENABLED=true` without required Slack secrets.
- `discord`: errors if `DISCORD_ENABLED=true` without `DISCORD_TOKEN`.
- `orchestration`: errors if `TASK_AUTO_PR=true` and `TASK_AUTO_COMMIT=false`.
- `control-plane`: warns if `CONTROL_AUTH_TOKEN` is missing.
- `storage` / `socket`: validates writable runtime directories.
- `runtime`: warns if running as root.

Run with a non-zero `CONTROL_AUTH_TOKEN` (and at least 24 chars) for production-like control-plane usage.

### Secret backend options

Secrets can be loaded from:

- direct env value (`KEY=value`, default),
- a file (`KEY_FILE=/absolute/path`),
- a command (`KEY_COMMAND=["/absolute/executable","arg1"]`).

Optional selector: `KEY_BACKEND=env|file|command`.

Supported keys: `CONTROL_AUTH_TOKEN`, `BRIDGE_SHARED_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `DISCORD_TOKEN`.

Command backend is disabled by default. Enable explicitly with `TALONBOT_SECRET_ALLOW_COMMAND=true`.

- `GET /health`
- `GET /status`
- `GET /sessions`
- `GET /aliases`
- `POST /dispatch` or `POST /send`
- `POST /stop`
- `POST /alias` with action `set|unset|resolve|list`
- `GET /tasks`, `POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/retry`, `POST /tasks/:id/cancel`
- `GET /repos`, `POST /repos/register`, `POST /repos/remove`
- `POST /bridge/envelope`, `POST /webhook/github`
- `GET /bridge/status`
- `GET /sentry/status`
- `GET /release/status`, `POST /release/update`, `POST /release/rollback`
- `POST /audit`, `POST /diagnostics/bundle`

Example:

```bash
curl -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" \
  -d '{"source":"discord","channelId":"12345","text":"run lint","senderId":"ops"}' \
  http://localhost:8080/dispatch

Alias maintenance:
```

```bash
curl -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"set","alias":"feature-chat","sessionKey":"discord:12345:main"}' \
  http://localhost:8080/alias
```
```

## Socket control

A Unix socket is always created at `${CONTROL_SOCKET_PATH}`.
Send one JSON command per line:

- `{"action":"send","source":"discord","channelId":"123","text":"status"}`
- `{"action":"stop","sessionKey":"discord:123:main"}`
- `{"action":"list"}`
- `{"action":"health"}`


## Queue and dedupe

- Per-route queue: `MAX_QUEUE_PER_SESSION`
- Queue overflow drops oldest pending event.
- Duplicate message suppression uses `SESSION_DEDUPE_WINDOW_MS`.

## Runtime directories

Session data lives under:

- `<DATA_DIR>/sessions/<hashed-session>/log.jsonl`
- `<DATA_DIR>/sessions/<hashed-session>/context.jsonl`
- `<DATA_DIR>/sessions/<hashed-session>/state.json`

## Production

Use `INSTALL.md` for a basic `systemd` bootstrap.

## Operator CLI

Daemon installs place a global `talonbot` command in `/usr/local/bin/talonbot`.

```bash
npm run cli -- status
npm run cli -- status --api
npm run cli -- doctor
npm run cli -- operator
npm run cli -- operator --json
npm run cli -- env set CONTROL_AUTH_TOKEN your-long-token
npm run cli -- env get CONTROL_AUTH_TOKEN
npm run cli -- repos register --id my-repo --path ~/workspace/my-repo --default true
npm run cli -- tasks create --repo my-repo --text "Implement endpoint hardening"
npm run cli -- tasks list
npm run cli -- attach --session discord:12345:main
npm run cli -- deploy --source /path/to/talonbot
npm run cli -- rollback previous
npm run cli -- audit
npm run cli -- bundle --output /tmp
npm run cli -- uninstall --force
```

Equivalent direct usage (after daemon install):

```bash
talonbot status
talonbot operator
talonbot tasks list
```

## Troubleshooting quick hits

- `talonbot status` shows service errors:
  - Run `talonbot status --api` to bypass `systemctl` fallback and check API reachability directly.
  - Run `talonbot operator` for a combined health/release/sentry snapshot.
- `talonbot doctor` reports startup errors:
  - Follow remediation text attached to each issue.
  - Re-run with runtime probe: `npm run doctor -- --strict --runtime-url http://127.0.0.1:8080 --runtime-token "$CONTROL_AUTH_TOKEN"`.
- Deploy or rollback fails:
  - Verify release state with `curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/release/status`.
  - Inspect service logs: `journalctl -u talonbot.service -f`.
