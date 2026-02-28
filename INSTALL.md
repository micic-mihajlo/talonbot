# Installation Notes

## 3-command quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/micic-mihajlo/talonbot/main/bootstrap.sh | bash
talonbot install
npm run start
```

Bootstrap installs:

- source at `~/.talonbot/src`
- CLI wrapper at `~/.local/bin/talonbot`

Install behavior (`talonbot install`):

- idempotent (safe to rerun)
- creates `.env` when missing
- generates `CONTROL_AUTH_TOKEN` when missing
- installs dependencies + builds runtime
- supports non-interactive usage (`--non-interactive` / `--yes`)

## Common install flags

```bash
talonbot install --doctor
talonbot install --start
talonbot install --daemon --doctor
talonbot install --token your-long-random-token
talonbot install --generate-token
```

## Linux daemon setup (systemd)

```bash
talonbot install --daemon --doctor
```

This installs `/etc/systemd/system/talonbot.service`, enables it, and starts it.

Check service:

```bash
sudo systemctl status talonbot.service
sudo journalctl -u talonbot.service -f
talonbot status --api
talonbot operator
```

## Troubleshooting

If `talonbot` is not found after bootstrap:

- add `~/.local/bin` to your shell profile `PATH`
- rerun bootstrap

If install fails on Node version:

- `talonbot` requires Node.js 20+
- verify with `node -v`

If service setup fails:

1. `npm run doctor -- --strict`
2. `talonbot status --api`
3. `sudo journalctl -u talonbot.service -f`
