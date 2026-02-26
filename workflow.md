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
