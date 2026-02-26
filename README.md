# Talonbot

`talonbot` is a Linux-first, always-on software-engineer agent runner with:

- Slack ingress (Socket Mode)
- Discord ingress
- Per-route session queues and persistent context
- Operator control surface (HTTP + Unix socket)
- Pluggable local execution engine (mock mode included)

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

cat > .env <<'EOF'
ENGINE_MODE=mock
ENGINE_COMMAND=
CONTROL_HTTP_PORT=8080
CONTROL_AUTH_TOKEN=
SLACK_ENABLED=false
DISCORD_ENABLED=false
EOF

npm install
npm run build
npm run start
```

The service starts immediately and listens on:

- Unix socket: `${CONTROL_SOCKET_PATH}` (default `~/.local/share/talonbot/control.sock`)
- HTTP control plane: port `8080` when set via `CONTROL_HTTP_PORT`

## Quick smoke checks

```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/sessions
curl -s -H "Content-Type: application/json" -d '{"source":"discord","channelId":"local","text":"hello bot","senderId":"you"}' http://localhost:8080/dispatch
```

You should get an accepted response from `/dispatch` and a reply text in logs/JSON.

Enable one transport when you’re ready to connect real chat:

- `SLACK_ENABLED=true` plus Slack tokens
- `DISCORD_ENABLED=true` plus Discord token

## Control API

Set `CONTROL_HTTP_PORT` to a non-zero value.

- `GET /health`
- `GET /sessions`
- `GET /aliases`
- `POST /dispatch` or `POST /send`
- `POST /stop`
- `POST /alias` with action `set|unset|resolve|list`

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
