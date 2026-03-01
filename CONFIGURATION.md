# Configuration

## P0 strict schema

- Config is parsed from environment using a strict Zod schema at process boot.
- `.env` defaults to `<repo>/.env`; override with `TALONBOT_ENV_FILE=/path/to/.env`.
- Unknown keys in the loaded `.env` file fail startup (typos are treated as errors), except vetted external prefixes used by engines/providers (`PI_`, `OPENAI_`, `ANTHROPIC_`, `AZURE_OPENAI_`, `GEMINI_`, `GROQ_`, `CEREBRAS_`, `XAI_`, `OPENROUTER_`, `AI_GATEWAY_`, `ZAI_`, `MISTRAL_`, `MINIMAX_`, `KIMI_`, `AWS_`, `CODEX_`).
- Boolean vars must be explicit: `true/false`, `1/0`, `yes/no`, or `on/off`.
- Cross-field constraints fail fast:
  - `ENGINE_MODE=process` requires non-empty `ENGINE_COMMAND`.
  - `WORKER_RUNTIME=tmux` requires `ENGINE_MODE=process`.
  - `SLACK_ENABLED=true` requires all three Slack secrets.
  - `DISCORD_ENABLED=true` requires `DISCORD_TOKEN`.
  - `TASK_AUTO_PR=true` requires `TASK_AUTO_COMMIT=true`.
- Startup exits before runtime initialization when startup validation contains any `error` severity issue.

## Core runtime

- `DATA_DIR` default: `~/.local/share/talonbot`
- `CONTROL_HTTP_PORT` default: `8080`
- `CONTROL_AUTH_TOKEN` required for secured control-plane access
- `CONTROL_SOCKET_PATH` default: `~/.local/share/talonbot/control.sock`
- `ENGINE_CWD` default: `~/.local/share/talonbot/engine` (process engine working directory)
- `PI_SKIP_VERSION_CHECK=1` is recommended for process-mode `pi` engine runs to avoid version-check stalls.
- `ENGINE_PROVIDER` optional explicit provider override passed to engine process (appended as `--provider`).
- `ENGINE_MODEL` optional explicit model override passed to engine process (appended as `--model`).
- `WORKER_RUNTIME` values: `inline`, `tmux` (default `inline`)
- `WORKER_SESSION_PREFIX` default: `dev-agent`
- `TMUX_BINARY` default: `tmux` (required when `WORKER_RUNTIME=tmux`)
- `WORKER_TMUX_POLL_MS` default: `500`

## Orchestration

- `REPO_ROOT_DIR` default: `~/workspace`
- `WORKTREE_ROOT_DIR` default: `~/workspace/worktrees`
- `TASK_MAX_CONCURRENCY` default: `3`
- `WORKER_MAX_RETRIES` default: `2`
- `TASK_AUTOCLEANUP` default: `true`
- `TASK_AUTO_COMMIT` default: `false`
- `TASK_AUTO_PR` default: `false`
- `PR_CHECK_TIMEOUT_MS` default: `900000` (15 min)
- `PR_CHECK_POLL_MS` default: `15000` (15 sec)
- `WORKTREE_STALE_HOURS` default: `24`
- `FAILED_WORKTREE_RETENTION_HOURS` default: `24` (`0` = cleanup failed/blocked worktrees immediately)
- `TASK_STUCK_MINUTES` default: `30` (running-task stale threshold for orchestration health monitor)
- `TASK_QUEUE_STALE_MINUTES` default: `30` (queued-task stale threshold for orchestration health monitor)

## Release / integrity

- `RELEASE_ROOT_DIR` default: `~/.local/share/talonbot/releases`
- `STARTUP_INTEGRITY_MODE` values: `off`, `warn`, `strict`

## Security hygiene

- `SESSION_LOG_RETENTION_DAYS` default: `14`
- `BRIDGE_SHARED_SECRET` optional, enables signed inbound bridge enforcement
- `BRIDGE_RETRY_BASE_MS` default: `2000`
- `BRIDGE_RETRY_MAX_MS` default: `30000`
- `BRIDGE_MAX_RETRIES` default: `5`
- `BRIDGE_STATE_FILE` default: `<DATA_DIR>/bridge/state.json`
- `SENTRY_ENABLED` default: `true`
- `SENTRY_POLL_MS` default: `10000`
- `SENTRY_STATE_FILE` default: `<DATA_DIR>/sentry/incidents.jsonl`

## Secret backends (P0)

Sensitive keys support three backends:

- `env` (default): `KEY=value`
- `file`: `KEY_FILE=/absolute/path/to/secret`
- `command`: `KEY_COMMAND=["/absolute/executable","arg1","arg2"]`

Optional override: `KEY_BACKEND=env|file|command`

Supported keys:

- `CONTROL_AUTH_TOKEN`
- `BRIDGE_SHARED_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `DISCORD_TOKEN`

Safety controls:

- `TALONBOT_SECRET_ALLOW_COMMAND` default: `false`
- `TALONBOT_SECRET_COMMAND_TIMEOUT_MS` default: `3000`
- `TALONBOT_SECRET_MAX_BYTES` default: `8192`

Notes:

- `*_FILE` paths must be absolute and point to readable files.
- `*_COMMAND` must be a JSON argv array; `argv[0]` must be an absolute executable path.
- Trailing newlines from file/command output are stripped.

## Transport toggles

- `SLACK_ENABLED` / `DISCORD_ENABLED`
- transport-specific token vars in `.env`

## Recommended production values

- `CONTROL_AUTH_TOKEN`: strong random secret (48+ chars)
- `STARTUP_INTEGRITY_MODE`: `strict`
- `TASK_MAX_CONCURRENCY`: match CPU and repo size (start with `2` or `3`)
- `WORKER_MAX_RETRIES`: `1` or `2` for fast escalation
- `SESSION_LOG_RETENTION_DAYS`: according to policy (for example `14` or `30`)
- `BRIDGE_SHARED_SECRET`: required for signed webhook/envelope ingress

## Release and rollback contract

- `POST /release/update` creates immutable snapshot content at `<RELEASE_ROOT_DIR>/releases/<id>`.
- activation moves `current` symlink atomically and rotates prior target to `previous`.
- `POST /release/rollback` with `previous` swaps back to the last known release.
- strict integrity mode fails startup if active release manifest verification fails.

## Bridge delivery contract

- accepted events are persisted as `queued` and dispatched asynchronously.
- retries use exponential backoff (`BRIDGE_RETRY_BASE_MS`, `BRIDGE_RETRY_MAX_MS`).
- events exceeding `BRIDGE_MAX_RETRIES` move to `poison`.
- duplicate message ids are marked `duplicate` and are not re-dispatched.
