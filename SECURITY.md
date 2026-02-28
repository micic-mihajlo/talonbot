# Security

## Runtime model

- Run `talonbot` as a dedicated non-root user.
- Protect control endpoints with `CONTROL_AUTH_TOKEN`.
- Keep repo checkout and runtime data in separate directories.
- Use release snapshots and integrity checks before activation.
- Prefer `*_FILE` secret backends over command-based secret loading.

## Trust boundaries

- External boundary: Slack/Discord/webhooks are untrusted input and must pass transport and bridge validation.
- Control boundary: HTTP and socket control APIs are privileged and must require a strong bearer token.
- Worker boundary: task workers execute repository code and toolchain commands in isolated worktrees.
- Host boundary: OS account, filesystem permissions, and service manager policies enforce final isolation.

## Controls in this repository

- Startup validation blocks hard misconfiguration.
- Session logs are redacted and pruned through runtime audit flows.
- Bridge ingestion supports signature verification + dedupe + poison detection.
- Task retries escalate after configurable failure thresholds.
- `bin/talonbot-safe-bash` blocks high-risk shell patterns.
- `bin/verify-manifest.sh` performs startup integrity checks (`off` / `warn` / `strict`).
- `bin/security-audit.sh` runs operational security posture checks (`--deep` optional).

## Operational checks

Use:

```bash
npm run doctor -- --strict
npm run cli -- audit
npm run cli -- audit --deep
```

## Known risks

- Worker execution uses shell and external tools; isolation must be enforced at OS level.
- Secrets can still leak through third-party tools if endpoint policy is weak.
- Bridge signatures are optional unless `BRIDGE_SHARED_SECRET` is configured.
- Enabling `TALONBOT_SECRET_ALLOW_COMMAND=true` increases attack surface; keep command paths absolute and tightly scoped.

## Required production baseline

- Set `CONTROL_AUTH_TOKEN` to a high-entropy value (minimum 24 chars, recommended 48+).
- Enable `STARTUP_INTEGRITY_MODE=strict`.
- Use a dedicated runtime user and deny root execution.
- Restrict inbound network to required control and webhook ports only.
- Keep `DATA_DIR` and `RELEASE_ROOT_DIR` on persistent storage with least-privilege permissions.

## Security verification cadence

- Per deploy:
- `npm run doctor -- --strict`
- `npm run cli -- audit`
- Weekly:
- `npm run cli -- audit --deep`
- `npm run cli -- bundle --output /tmp`
