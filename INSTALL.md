# Installation Notes

`./install.sh` keeps setup simple and VPS-friendly.

By default it:
- creates `.env` if missing (mock mode, no external tokens),
- installs dependencies,
- builds the app,
- and prints next-step run commands.

Set environment variables before running if you want different defaults:
- `ENGINE_MODE` (`mock` or `process`)
- `CONTROL_HTTP_PORT`
- `SLACK_ENABLED`
- `DISCORD_ENABLED`
- `SERVICE_USER` (daemon mode, defaults to your user)
- any transport secrets/tokens.

## Local smoke test

```bash
cd /path/to/talonbot
./install.sh
node dist/index.js
```

This gives you a running instance on `localhost:8080` with socket control for testing.

## Linux daemon setup (systemd)

```bash
cd /path/to/talonbot
sudo ./install.sh --daemon
```

This installs `/etc/systemd/system/talonbot.service`, enables it, and starts it.

Check service:

```bash
sudo systemctl status talonbot.service
sudo journalctl -u talonbot.service -f
```

Foreground run for quick iteration:

```bash
./install.sh --start
```
