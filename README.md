# Skyblocker AFK Client (desktop app)

1. Install Node.js 18+ from https://nodejs.org
2. In this folder: `npm install`  then  `npm start`

Tabs: Connect (server, delay, options, join messages, account selection), Chat (send + spam + live chat),
Accounts (add premium/offline, unlimited), Movement, Proxies (SOCKS5).
Use "Add Microsoft account" on the Accounts tab: your browser opens with the code filled in. Sign in and accept.

## Build a normal Windows app
Run `npm install` then `npm run dist`. The installer and a portable .exe appear in the `dist` folder.

## Auto updates
The installed app (Setup.exe) checks GitHub Releases on startup and every 4 hours. New versions download in
the background and install the next time you close the app, or straight away with the "Restart & update" banner.
(The portable .exe does not auto-update.)

To ship an update:
1. Bump `"version"` in `package.json` (e.g. 1.1.0 -> 1.1.1).
2. Commit, then tag and push:  `git tag v1.1.1`  `git push origin main --tags`
3. GitHub Actions builds it and publishes the release. Everyone's app updates itself on next restart.

Logs are in `%APPDATA%\my-afk-client\logs\main.log` if something goes wrong.
