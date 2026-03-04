<p align="center">
  <img src="docs/assets/talonbot-logo.png" alt="Talonbot logo" width="240" />
</p>

<h1 align="center">Talonbot</h1>

<p align="center">
  Always-on AI engineering teammate for Linux, Slack, and Discord.
</p>

Talonbot is a Linux-first agent runtime that turns chat messages into tracked engineering tasks with evidence-backed completion.

You can message it from Slack/Discord, it runs work in isolated git worktrees, and it posts lifecycle updates back in-thread.

## Why Talonbot

- 24/7 daemon runtime on Linux (`systemd`-friendly)
- Task-first chat flow with lifecycle updates: queued, running, blocked, done
- Intent-aware completion policy:
  - `implementation` requests can require verified PR evidence
  - `research/review/summarize` requests complete on summary artifacts
- Isolated repo execution pipeline with worktree cleanup and worker supervision
- Durable transport outbox with retry/backoff/poison handling
- Strict startup integrity checks and release rollback operations
- Memory backends:
  - local markdown memory (`MEMORY_PROVIDER=local`)
  - semantic recall with local QMD (`MEMORY_PROVIDER=qmd`)

## How it works

1. Inbound chat event is normalized (Slack/Discord).
2. Control plane routes request to `task` or `session`.
3. Task orchestration assigns a worker and isolated repo worktree.
4. Engine executes (mock/process/session mode).
5. Artifacts are verified (summary/branch/commit/PR policy).
6. Status updates are posted back to the same chat thread.

## Quickstart (local, 3 commands)

```bash
curl -fsSL https://raw.githubusercontent.com/micic-mihajlo/talonbot/main/bootstrap.sh | bash
talonbot install
npm run start
```

Defaults after startup:

- HTTP control API: `http://127.0.0.1:8080`
- Unix socket: `~/.local/share/talonbot/control.sock`

## Quickstart (Linux daemon / VPS)

```bash
talonbot setup --admin-user <admin-user> --runtime-user talonbot
talonbot install --daemon --doctor
```

If you want real process-engine execution with `pi`:

```bash
npm install -g @mariozechner/pi-coding-agent
talonbot env set ENGINE_MODE process
talonbot env set ENGINE_COMMAND "$(command -v pi)"
talonbot env set ENGINE_ARGS "-p --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools"
talonbot env set PI_SKIP_VERSION_CHECK 1
sudo systemctl restart talonbot.service
```

## First smoke test

```bash
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/status
curl -s -H "Content-Type: application/json" \
  -d '{"source":"discord","channelId":"local","text":"hello bot","senderId":"you"}' \
  http://127.0.0.1:8080/dispatch
```

## Transport modes

- `CHAT_TRANSPORT_PROVIDER=legacy`
  - legacy Slack Bolt + Discord gateway transports
- `CHAT_TRANSPORT_PROVIDER=chat_sdk`
  - Chat SDK transport only (Redis required)
- `CHAT_TRANSPORT_PROVIDER=dual`
  - both stacks with cross-stack dedupe guard

## Memory modes

- `MEMORY_PROVIDER=local`
  - markdown memory only
- `MEMORY_PROVIDER=qmd`
  - markdown baseline + semantic recall snippets via local `qmd` CLI
  - fail-open fallback to markdown-only if qmd lookup fails

## Operator commands

```bash
talonbot status
talonbot operator
talonbot doctor
talonbot tasks list
talonbot workers list
talonbot audit
talonbot update --source /path/to/talonbot
talonbot rollback previous
```

## API surface (most-used)

- `GET /health`
- `GET /status`
- `POST /dispatch`
- `GET /tasks`
- `GET /tasks/:id`
- `GET /tasks/:id/report`
- `POST /tasks/:id/retry`
- `POST /tasks/:id/cancel`
- `GET /workers`
- `GET /repos`
- `POST /diagnostics/bundle`

## CI quality gates

Required checks include:

- `build`
- `lint`
- `typecheck`
- `tests`
- `smoke`
- `e2e-process` (self-hosted runner labels: `self-hosted,linux,pi`)

Run local p0 gate sequence:

```bash
npm run ci:p0
```

## Docs map

- Install and Linux host setup: `INSTALL.md`
- Full config reference: `CONFIGURATION.md`
- Architecture details: `architecture.md`
- Ops runbook: `operations.md`
- Workflow semantics: `workflow.md`
- Security posture: `SECURITY.md`

## Notes for contributors

- Task-first mode is default for transport messages.
- Use `chat: ...` or `/chat ...` to force plain conversational session mode.
- Keep commit messages free of banned naming constraints in this repo.
