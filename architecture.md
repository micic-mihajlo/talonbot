# Architecture

## Topology

- `control plane`: receives transport messages and operator commands
- `task orchestrator`: tracks task lifecycle and worker execution
- `dev workers`: task-scoped execution loops in isolated worktrees
- `bridge ingress`: normalizes webhook/envelope inputs with idempotency
- `release manager`: snapshot, activate, rollback, integrity validation

## Data layout

- runtime state: `<DATA_DIR>/sessions`, `<DATA_DIR>/tasks`, `<DATA_DIR>/repos`
- memory: `<DATA_DIR>/memory/*.md`
- releases: `<RELEASE_ROOT_DIR>/releases/<sha>` + `current` / `previous` symlinks

## Task flow

1. request enters via transport/API/webhook
2. orchestrator queues task (`queued`)
3. worker starts (`running`) in git worktree
4. worker finishes (`done`) or escalates (`blocked`/`failed`)
5. artifacts persist (summary, optional commit/PR/checks)
