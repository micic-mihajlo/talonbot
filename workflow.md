# Workflow

## Standard execution loop

1. register target repos
2. submit tasks to orchestrator
3. let workers execute in isolated worktrees
4. inspect artifacts (summary/commit/PR/checks)
5. retry or escalate blocked tasks

## Fan-out / fan-in

Use `--fanout` to split a parent request into parallel child tasks.
Parent task closes after all children complete.

## Failure handling

- automatic retry until `WORKER_MAX_RETRIES`
- then task state moves to `failed`
- `escalationRequired=true` signals operator handoff

## P0 CI gate workflow

Every pull request and `main` push must pass:

1. `build`
2. `lint`
3. `typecheck`
4. `tests`
5. `smoke`

`p0-gates` is the aggregate required check in GitHub Actions and fails if any gate above is not successful.
For local parity, run `npm run ci:p0`.

## Deploy and rollback workflow

1. run `npm run doctor -- --strict`
2. deploy: `npm run cli -- deploy --source /path/to/source`
3. verify: `/health`, `/release/status`, `/bridge/status`
4. if release is unstable, rollback: `npm run cli -- rollback previous`
5. collect diagnostics bundle and open follow-up task

## Day-2 hygiene workflow

1. prune sessions and logs: `npm run cli -- prune`
2. run audit: `npm run cli -- audit --deep`
3. inspect bridge poison queue: `GET /bridge/status`
4. inspect failed tasks and escalate owners
