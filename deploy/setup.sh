#!/usr/bin/env bash
# One-time setup of the AFK Client web version on a fresh Ubuntu 22.04/24.04 VPS.
# Run as root:   bash setup.sh
# Optional:      DOMAIN=afk.example.com bash setup.sh   (otherwise a free <ip>.sslip.io address is used)
set -euo pipefail

REPO="git@github.com:Cronk3d/AFK-Client-App.git"
APP_DIR=/opt/afk-client
DATA_DIR=/var/lib/afk-client
ENV_FILE=/etc/afk-client.env
SVC_USER=afk

[ "$(id -u)" -eq 0 ] || { echo "Run this as root (sudo bash setup.sh)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (automatic HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# A little swap so a memory spike can't kill the bots
if ! swapon --show | grep -q .; then
  echo "==> Adding 2G swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$SVC_USER --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$DATA_DIR" && chown "$SVC_USER:$SVC_USER" "$DATA_DIR" && chmod 700 "$DATA_DIR"

echo "==> GitHub access (read-only deploy key for your private repo)"
KEY=/root/.ssh/afk_deploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -C "afk-vps-deploy" -f "$KEY" >/dev/null
grep -q "Host github.com" /root/.ssh/config 2>/dev/null || cat >> /root/.ssh/config <<EOF
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
until git ls-remote "$REPO" >/dev/null 2>&1; do
  echo
  echo "--------------------------------------------------------------------------"
  echo "Add this key on GitHub: Cronk3d/AFK-Client-App > Settings > Deploy keys >"
  echo "Add deploy key. Title: VPS. Leave 'Allow write access' UNticked."
  echo
  cat "$KEY.pub"
  echo "--------------------------------------------------------------------------"
  read -rp "Press Enter once you've added it... " _
done

echo "==> Downloading the app"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund

if [ ! -f "$ENV_FILE" ]; then
  echo
  while :; do
    read -rsp "Choose a password for the web page (8+ characters): " PW; echo
    read -rsp "Type it again: " PW2; echo
    [ "$PW" = "$PW2" ] && [ ${#PW} -ge 8 ] && break
    echo "Didn't match or too short - try again."
  done
  umask 077
  printf 'AFK_PASSWORD=%s\nDATA_DIR=%s\nPORT=3000\nHOST=127.0.0.1\n' "$PW" "$DATA_DIR" > "$ENV_FILE"
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
fi

echo "==> Creating the background service"
cat > /etc/systemd/system/afk-client.service <<EOF
[Unit]
Description=Skyblocker AFK Client (web)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# Bots keep running even if one misbehaves; give it room for 16+ alts
Environment=NODE_OPTIONS=--max-old-space-size=3072
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

install -m 755 "$APP_DIR/deploy/update.sh" /usr/local/bin/afk-update
systemctl daemon-reload
systemctl enable --now afk-client
systemctl restart afk-client

echo "==> HTTPS"
IP=$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
SITE=${DOMAIN:-${IP//./-}.sslip.io}
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl restart caddy

ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

echo
echo "=========================================================================="
echo " Done!  Open:  https://$SITE"
echo " (first load can take ~30s while the HTTPS certificate is issued)"
echo
echo " Update to the newest version:   afk-update"
echo " Live logs:                       journalctl -u afk-client -f"
echo " Restart:                         systemctl restart afk-client"
echo " Change password:                 nano $ENV_FILE  then  systemctl restart afk-client"
echo "=========================================================================="
