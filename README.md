# Skyblocker AFK Client (desktop app)

1. Install Node.js 18+ from https://nodejs.org
2. In this folder: `npm install`  then  `npm start`

Tabs: Connect (server, delay, options, join messages, account selection), Chat (send + spam + live chat),
Accounts (add premium/offline, unlimited), Movement, Proxies (SOCKS5).
Use "Add Microsoft account" on the Accounts tab: your browser opens with the code filled in. Sign in and accept.

## Build a normal Windows app
Run `npm install` then `npm run dist`. The installer and a portable .exe appear in the `dist` folder.

## Auto updates
The installed app (Setup.exe) checks the public Cronk3d/AFK-Client-Releases repo on startup and every 4 hours. New versions download in
the background and install the next time you close the app, or straight away with the "Restart & update" banner.
(The portable .exe does not auto-update.)

To ship an update:
1. Bump `"version"` in `package.json` (e.g. 1.1.0 -> 1.1.1).
2. Commit, then tag and push:  `git tag v1.1.1`  `git push origin main --tags`
3. GitHub Actions builds it and publishes the release. Everyone's app updates itself on next restart.

Logs are in `%APPDATA%\my-afk-client\logs\main.log` if something goes wrong.

## Web version (run 24/7 on a VPS)
Same app, but the bots run on a server and you control them from any browser or your phone (password protected, HTTPS).
Alts that were online come back automatically after a restart, crash or reboot.

**Setup (Ubuntu 22.04/24.04 VPS, e.g. Hetzner CX22):**
1. SSH into the VPS as root and run:
   `curl -fsSL -o setup.sh https://raw.githubusercontent.com/Cronk3d/AFK-Client-Releases/main/setup.sh && bash setup.sh`
   (or copy `deploy/setup.sh` over and run `bash setup.sh`)
2. It prints a key - add it on GitHub under this repo > Settings > Deploy keys (read-only), press Enter.
3. Pick a password. At the end it prints your link, e.g. `https://1-2-3-4.sslip.io`.

**On the VPS:** `afk-update` (get newest version) · `journalctl -u afk-client -f` (live logs) · `systemctl restart afk-client`

Run it locally instead: `AFK_PASSWORD=yourpassword npm run web` then open http://127.0.0.1:3000
