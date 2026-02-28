# Installation Notes

`./install.sh` keeps setup simple and VPS-friendly.

By default it:
- creates `.env` if missing (mock mode, no external tokens),
- installs dependencies,
- builds the app,
- and prints next-step run commands.

Optional verification:
- add `--doctor` to run post-install checks and runtime probes.

Set environment variables before running if you want different defaults:
- `ENGINE_MODE` (`mock` or `process`)
- `CONTROL_HTTP_PORT`
- `SLACK_ENABLED`
- `DISCORD_ENABLED`
- `SERVICE_USER` (daemon mode, defaults to your user)
- any transport secrets/tokens.

Secret loading options:

- default: `KEY=value` in `.env`
- file backend: `KEY_FILE=/absolute/path/to/secret`
- command backend: `KEY_COMMAND=["/absolute/executable","arg1"]` with `TALONBOT_SECRET_ALLOW_COMMAND=true`

## Local smoke test

```bash
cd /path/to/talonbot
./install.sh --doctor
node dist/index.js
```

This gives you a running instance on `localhost:8080` with socket control for testing.

Validate the environment before long-lived deployment:

```bash
npm run doctor
npm run doctor -- --strict --runtime-url http://localhost:8080 --runtime-token "$CONTROL_AUTH_TOKEN"
npm run cli -- status
```

## Linux daemon setup (systemd)

```bash
cd /path/to/talonbot
sudo ./install.sh --daemon --doctor
```

This installs `/etc/systemd/system/talonbot.service`, enables it, and starts it.

Check service:

```bash
sudo systemctl status talonbot.service
sudo journalctl -u talonbot.service -f
talonbot status --api
talonbot operator
```

## Linux VPS bootstrap with explicit templates

For explicit VPS control, you can use the template files directly:

```bash
cd /path/to/talonbot
cp systemd/talonbot.env.template .env
# Required: set at least CONTROL_AUTH_TOKEN and enabled transport tokens
nano .env

cp systemd/talonbot.service /etc/systemd/system/talonbot.service
sudo systemctl daemon-reload
sudo systemctl enable --now talonbot
```

Recommended:

- Put runtime files under `/var/lib/talonbot` in `.env`.
- Restrict `.env` file: `chmod 600 .env`.
- Tail logs: `sudo journalctl -u talonbot -f`.
- Restart after env changes: `sudo systemctl restart talonbot`.

Foreground run for quick iteration:

```bash
./install.sh --start
```

## Troubleshooting service setup

If `systemctl status talonbot.service` shows startup failure:

1. Validate environment and runtime:
- `npm run doctor -- --strict`
- `npm run doctor -- --strict --runtime-url http://127.0.0.1:8080 --runtime-token "$CONTROL_AUTH_TOKEN"`
2. Validate file and user permissions:
- `ls -ld "$(dirname "$CONTROL_SOCKET_PATH")" "$DATA_DIR" "$RELEASE_ROOT_DIR"`
- Ensure `SERVICE_USER` owns writable runtime paths.
3. Validate control API auth behavior:
- `talonbot status --api`
- If unauthorized, update `CONTROL_AUTH_TOKEN` in `.env` and restart service.
