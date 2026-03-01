# Operations

## Service lifecycle

```bash
npm run cli -- start
npm run cli -- stop
npm run cli -- restart
npm run cli -- status
npm run cli -- status --api
npm run cli -- operator
npm run cli -- logs
npm run cli -- doctor
```

## Health and dependency checks

```bash
curl -s http://127.0.0.1:8080/health | jq
curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/status | jq
curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/release/status | jq
curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/bridge/status | jq
curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/sentry/status | jq
```

## Task operations

```bash
npm run cli -- repos register --id my-repo --path ~/workspace/my-repo --default true
npm run cli -- tasks create --repo my-repo --text "Fix flaky CI"
npm run cli -- tasks list
npm run cli -- tasks get <task-id>
npm run cli -- workers list
npm run cli -- workers cleanup
npm run cli -- workers stop --session <worker-session>
npm run cli -- attach --session <session-key>
```

Strict task-first chat contract:
- non-command Discord/Slack messages dispatch as tasks by default.
- use `chat: <message>` (or `/chat <message>`) for conversational session turns.
- terminal `done` requires verified PR evidence when `CHAT_REQUIRE_VERIFIED_PR=true`.

## Release operations

```bash
npm run cli -- deploy --source /path/to/talonbot
npm run cli -- rollback previous
npm run cli -- rollback <release-sha>
```

Expected result for a successful deploy:
- `/release/status` shows `current` pointing to the new release id.
- `/health` dependency block shows the same release in `dependencies.release.current`.

## Incident response runbook

1. Triage impact:
- Check `/health`, `/status`, and `npm run cli -- logs`.
- Confirm whether failure is in transport, orchestration, bridge, release, or host environment.
2. Stabilize:
- Stop new risky actions (`npm run cli -- stop` if needed).
- Run `npm run cli -- audit --deep` and `npm run doctor -- --strict`.
3. Roll back if the active release is suspect:
- `npm run cli -- rollback previous`.
- Verify health and status endpoints.
4. Recover service:
- `npm run cli -- restart`.
- Confirm session/task flow resumes.
5. Preserve evidence:
- `npm run cli -- bundle --output /tmp`.
- Archive the diagnostics bundle with timestamp and incident id.

## Operator status drill

Run this sequence before deploy or after an incident:

1. `npm run cli -- operator`
2. `npm run doctor -- --strict --runtime-url http://127.0.0.1:8080 --runtime-token "$CONTROL_AUTH_TOKEN"`
3. `npm run cli -- status --api`

Expected outcome:
- Operator summary shows reachable health/runtime/release probes.
- Doctor returns zero errors.
- API status responds with current runtime details and sessions/aliases arrays.

## Rollback playbook

1. Identify the target release:
- `curl -s -H "Authorization: Bearer $CONTROL_AUTH_TOKEN" http://127.0.0.1:8080/release/status`.
2. Execute rollback:
- `npm run cli -- rollback previous` or `npm run cli -- rollback <release-sha>`.
3. Verify:
- `/health` and `/release/status` both reflect the expected current release.
- `npm run cli -- doctor -- --strict --runtime-url http://127.0.0.1:8080 --runtime-token "$CONTROL_AUTH_TOKEN"`.
4. If verification fails:
- Roll forward to a known-good explicit release id.
- Collect diagnostics and hold deploys.

## Environment management

```bash
npm run cli -- env list
npm run cli -- env get CONTROL_AUTH_TOKEN
npm run cli -- env set CONTROL_AUTH_TOKEN your-long-token
npm run cli -- env sync
```

## Security and diagnostics

```bash
npm run cli -- audit
npm run cli -- prune
npm run cli -- audit --deep
npm run cli -- sentry status
npm run cli -- firewall --dry-run
npm run cli -- bundle --output /tmp
```

Transport outbox remediation:
1. Generate a diagnostics bundle and inspect `transport-outbox.discord.json` and `transport-outbox.slack.json`.
2. If poison records exist, confirm channel/thread reachability and credentials.
3. Restart service after remediation: `npm run cli -- restart`.
4. Re-run `npm run doctor -- --strict` and verify no new poison growth.

## Uninstall

```bash
npm run cli -- uninstall --force
```
