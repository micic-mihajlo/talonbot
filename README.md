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

## Quick start (local)

```bash
cd /path/to/talonbot
cp .env.example .env
npm install
npm run build
npm run dev
```

Enable at least one transport before starting.

## Control API (optional)

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
