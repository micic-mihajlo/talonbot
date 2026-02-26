# Operations

## Service lifecycle

```bash
npm run cli -- start
npm run cli -- stop
npm run cli -- restart
npm run cli -- status
npm run cli -- logs
npm run cli -- doctor
```

## Task operations

```bash
npm run cli -- repos register --id my-repo --path ~/workspace/my-repo --default true
npm run cli -- tasks create --repo my-repo --text "Fix flaky CI"
npm run cli -- tasks list
npm run cli -- tasks get <task-id>
npm run cli -- attach --session <session-key>
```

## Environment management

```bash
npm run cli -- env list
npm run cli -- env get CONTROL_AUTH_TOKEN
npm run cli -- env set CONTROL_AUTH_TOKEN your-long-token
npm run cli -- env sync
```

## Release operations

```bash
npm run cli -- deploy --source /path/to/talonbot
npm run cli -- rollback previous
npm run cli -- rollback <release-sha>
```

## Security and diagnostics

```bash
npm run cli -- audit
npm run cli -- prune
npm run cli -- audit --deep
npm run cli -- firewall --dry-run
npm run cli -- bundle --output /tmp
```

## Uninstall

```bash
npm run cli -- uninstall --force
```
