# Installation Notes

## Linux daemon setup

Quick one-command smoke test (same repo, no API keys):

```bash
cd /path/to/talonbot
cp .env.example .env

cat > .env <<'EOF'
ENGINE_MODE=mock
ENGINE_COMMAND=
CONTROL_HTTP_PORT=8080
CONTROL_AUTH_TOKEN=
SLACK_ENABLED=false
DISCORD_ENABLED=false
EOF

npm install
npm run build
node dist/index.js
```

This gives you a running instance on `localhost:8080` and socket control for local testing.

Long-lived service:

- Build once:

```bash
cd /path/to/talonbot
npm install
npm run build
```

- Copy service file and set paths/user:

```bash
sudo cp systemd/talonbot.service /etc/systemd/system/talonbot@.service
sudo systemctl daemon-reload
sudo systemctl enable talonbot@youruser.service
sudo systemctl start talonbot@youruser.service
```

Set `/home/youruser/talonbot/.env` before enabling.
