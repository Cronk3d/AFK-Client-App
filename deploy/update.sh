#!/usr/bin/env bash
# Pull the newest version from GitHub and restart. Installed as `afk-update` by setup.sh.
# Alts disconnect for a few seconds and reconnect automatically.
set -euo pipefail
APP_DIR=/opt/afk-client
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo afk-update"; exit 1; }
cd "$APP_DIR"
OLD=$(git rev-parse HEAD)
git pull --ff-only
if [ "$OLD" = "$(git rev-parse HEAD)" ]; then echo "Already up to date ($(node -p "require('./package.json').version"))."; exit 0; fi
npm ci --omit=dev --no-audit --no-fund
install -m 755 "$APP_DIR/deploy/update.sh" /usr/local/bin/afk-update
systemctl restart afk-client
echo "Updated to $(node -p "require('./package.json').version") - alts are reconnecting."
