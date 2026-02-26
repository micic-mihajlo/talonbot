# Security

## Runtime model

- Run `talonbot` as a dedicated non-root user.
- Protect control endpoints with `CONTROL_AUTH_TOKEN`.
- Keep repo checkout and runtime data in separate directories.
- Use release snapshots and integrity checks before activation.

## Controls in this repository

- Startup validation blocks hard misconfiguration.
- Session logs are redacted and pruned through runtime audit flows.
- Bridge ingestion supports signature verification + dedupe + poison detection.
- Task retries escalate after configurable failure thresholds.

## Operational checks

Use:

```bash
npm run doctor -- --strict
npm run cli -- audit
```

## Known risks

- Worker execution uses shell and external tools; isolation must be enforced at OS level.
- Secrets can still leak through third-party tools if endpoint policy is weak.
- Bridge signatures are optional unless `BRIDGE_SHARED_SECRET` is configured.
