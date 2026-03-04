# Architecture

## Topology

- `control plane`: receives transport messages and operator commands
- `task orchestrator`: tracks task lifecycle and worker execution
- `dev workers`: task-scoped execution loops in isolated worktrees
- `sentry agent`: monitors escalated tasks and records incidents
- `bridge ingress`: normalizes webhook/envelope inputs with idempotency
- `release manager`: snapshot, activate, rollback, integrity validation
- `memory provider`: markdown baseline with optional semantic retrieval overlay

## Data layout

- runtime state: `<DATA_DIR>/sessions`, `<DATA_DIR>/tasks`, `<DATA_DIR>/repos`
- memory: `<DATA_DIR>/memory/*.md` (source of truth) + optional qmd semantic index over same workspace
- releases: `<RELEASE_ROOT_DIR>/releases/<sha>` + `current` / `previous` symlinks
- bridge state: `<DATA_DIR>/bridge/state.json` for envelope retries and poison tracking

## Task flow

1. request enters via transport/API/webhook
2. orchestrator queues task (`queued`)
3. deterministic launcher creates task-scoped branch/worktree + assigned worker session (`running`)
4. explicit status transitions are audited (`queued -> running -> done|failed`, plus `blocked/cancelled`)
5. completion policy is attached per task (`taskIntent`, `requiresVerifiedPr`, `requiredArtifacts`)
6. worker prompt includes memory context (markdown baseline, optionally enriched by semantic recall)
7. artifact-backed reports persist (launcher metadata, summary, changed files, optional commit/PR/checks/test output)
8. non-LLM health monitor reports orphaned workers, stuck tasks, and stale worktrees via `/status`

## Release flow

1. operator triggers deploy with source path
2. release manager resolves deterministic release id from git revision or source fingerprint
3. snapshot is copied to a release directory and manifest metadata is written
4. activation verifies snapshot integrity and atomically updates `current`
5. previous `current` target becomes `previous` for rollback

## Failure domains

- transport failures are isolated from task orchestration state.
- worker failures are retried and escalate after retry budget exhaustion.
- bridge dispatch failures are persisted and retried with backoff.
- release activation fails closed when manifest verification does not pass.

## Strict runtime and release layout

Daemon deployments run from immutable releases:

```text
/opt/talonbot/
  releases/<sha>/
  current -> releases/<sha>
  previous -> releases/<sha>
/etc/talonbot/talonbot.env
/var/lib/talonbot/
```

`start.sh` executes from `current`, applies security preflight, verifies manifest integrity, and only then launches `dist/index.js`.
