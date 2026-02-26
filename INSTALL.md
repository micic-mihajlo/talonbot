# Installation Notes

## Linux daemon setup

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
