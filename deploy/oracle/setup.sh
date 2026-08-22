#!/usr/bin/env bash
# Always Free Ampere (ARM) Ubuntu. Run as ubuntu after the pack is in /opt/vela.
set -euo pipefail
cd /opt/vela

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo mkdir -p /var/lib/vela
sudo chown "$USER:$USER" /var/lib/vela

if [ ! -f /opt/vela/.env ]; then
  SECRET=$(openssl rand -hex 24)
  IP=$(curl -fsS -m 4 http://169.254.169.254/opc/v2/vnics/ 2>/dev/null | sed -n 's/.*"publicIp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)
  IP=${IP:-$(curl -fsS -m 4 https://ifconfig.me || echo "YOUR.VM.IP")}
  cat >/opt/vela/.env <<EOF
VELA_WORKER=1
PGLITE_DATA_DIR=/var/lib/vela/pglite
BETTER_AUTH_SECRET=${SECRET}
BETTER_AUTH_URL=http://${IP}:8080
HOST=0.0.0.0
PORT=8080
EOF
fi

npm ci
npm run build

sudo tee /etc/systemd/system/vela.service >/dev/null <<'UNIT'
[Unit]
Description=VELA WEEX worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/vela
EnvironmentFile=/opt/vela/.env
ExecStart=/usr/bin/npm run preview -- --host 0.0.0.0 --port 8080
Restart=always
RestartSec=4
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now vela.service
sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT 2>/dev/null || true
echo "VELA is up. Open http://$(hostname -I | awk '{print $1}'):8080  Sign in, store WEEX keys, arm."
