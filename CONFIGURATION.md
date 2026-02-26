# Configuration

## Core runtime

- `DATA_DIR` default: `~/.local/share/talonbot`
- `CONTROL_HTTP_PORT` default: `8080`
- `CONTROL_AUTH_TOKEN` required for secured control-plane access
- `CONTROL_SOCKET_PATH` default: `~/.local/share/talonbot/control.sock`

## Orchestration

- `REPO_ROOT_DIR` default: `~/workspace`
- `WORKTREE_ROOT_DIR` default: `~/workspace/worktrees`
- `TASK_MAX_CONCURRENCY` default: `3`
- `WORKER_MAX_RETRIES` default: `2`
- `TASK_AUTOCLEANUP` default: `true`
- `TASK_AUTO_COMMIT` default: `false`
- `TASK_AUTO_PR` default: `false`
- `WORKTREE_STALE_HOURS` default: `24`

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

## Transport toggles

- `SLACK_ENABLED` / `DISCORD_ENABLED`
- transport-specific token vars in `.env`
