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
- `PR_CHECK_TIMEOUT_MS` default: `900000` (15 min)
- `PR_CHECK_POLL_MS` default: `15000` (15 sec)
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
