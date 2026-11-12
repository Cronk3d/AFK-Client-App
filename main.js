// Desktop (Electron) front end. All bot logic lives in core.js, shared with the web version (server.js).
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');
const createCore = require('./core');

// Keep saved accounts/settings in one fixed folder, whether run from npm or the installed app
// (AFK_USER_DATA lets a second test copy run with its own data, without touching your real accounts)
app.setPath('userData', process.env.AFK_USER_DATA || path.join(app.getPath('appData'), 'my-afk-client'));

// Log file: %APPDATA%\my-afk-client\logs\main.log
log.initialize();
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024;

// Only one copy of the app may run, otherwise two copies fight over the same config and sign-ins
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// A stray error from one bot (bad packet, proxy drop, etc.) must never take down the whole app
process.on('uncaughtException', e => log.error('Uncaught exception:', e));
process.on('unhandledRejection', e => log.error('Unhandled rejection:', e));

let win, core;
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);

// Opens a URL in a private/incognito window on Windows so each sign-in starts fresh
function openUrl(url) {
  if (!(core.cfg.opt.privateSignin && process.platform === 'win32')) return shell.openExternal(url);
  const browsers = [['msedge', '--inprivate'], ['chrome', '--incognito'], ['firefox', '-private-window']];
  const next = i => {
    if (i >= browsers.length) return shell.openExternal(url);
    const c = spawn('cmd.exe', ['/c', 'start', '', browsers[i][0], browsers[i][1], url], { windowsHide: true, stdio: 'ignore' });
    c.on('error', () => next(i + 1));
    c.on('exit', code => { if (code !== 0) next(i + 1); });
  };
  next(0);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, backgroundColor: '#0f0f0f', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  // If the UI ever crashes, reload it - the bots keep running in the background either way
  win.webContents.on('render-process-gone', (_, d) => { log.error('Renderer gone:', d.reason); if (d.reason !== 'clean-exit') setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000); });
  win.on('unresponsive', () => log.warn('Window unresponsive'));
}

// ---------- Auto updater ----------
// Checks GitHub Releases. New versions download in the background and install the next time the app is closed/restarted.
let updateState = { status: 'idle' };
const setUpdate = st => { updateState = st; send('update', st); };
function setupUpdater() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return; // only the installed (Setup.exe) version can self-update
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { if (updateState.status !== 'ready') setUpdate({ status: 'checking' }); });
  autoUpdater.on('update-available', i => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'idle' }));
  autoUpdater.on('download-progress', p => setUpdate({ ...updateState, status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => setUpdate({ status: 'ready', version: i.version }));
  autoUpdater.on('error', e => { log.warn('Updater error:', e && e.message); if (updateState.status !== 'ready') setUpdate({ status: 'idle' }); });
  const check = () => { if (updateState.status !== 'ready') autoUpdater.checkForUpdates().catch(e => log.warn('Update check failed:', e && e.message)); };
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000); // and every 4 hours while it's left running
}

app.whenReady().then(() => {
  core = createCore({
    dataDir: app.getPath('userData'), send, log,
    // Opens the Microsoft sign-in page with the code already filled in, and copies the code as a backup
    onMsaCode: (d, label, url) => { clipboard.writeText(d.user_code); openUrl(url); },
    openUrl,
    afterWipe: async () => {
      try { await win.webContents.session.clearStorageData(); await win.webContents.session.clearCache(); } catch {}
      win.reload();
    },
  });
  createWindow(); setupUpdater();
  win.webContents.once('did-finish-load', () => core.resume()); // alts that were online when the app closed (or updated) come back

  for (const [ch, fn] of Object.entries(core.handlers)) ipcMain.handle(ch, (_, ...args) => fn(...args));
  ipcMain.handle('version', () => app.getVersion());
  ipcMain.handle('updateState', () => updateState);
  ipcMain.handle('installUpdate', () => {
    if (updateState.status !== 'ready') return;
    core.stopAll(false);
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent install, then relaunch
  });
});
app.on('before-quit', () => {
  // Disconnect bots cleanly so servers don't see a timeout/ghost player
  if (core) core.stopAll(false);
});
app.on('will-quit', () => { if (core && core.cfg.opt.wipeOnExit) core.wipeData(); });
app.on('window-all-closed', () => app.quit());
