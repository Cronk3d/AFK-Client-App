const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { Authflow, Titles } = require('prismarine-auth');

const log = require('electron-log/main');
const { autoUpdater } = require('electron-updater');

// Keep saved accounts/settings in one fixed folder, whether run from npm or the installed app
app.setPath('userData', path.join(app.getPath('appData'), 'my-afk-client'));

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

const defaults = {
  server: { host: '', version: '', delay: 5 },
  opt: { sneak: false, physics: true, antiAfk: true, reconnect: true, wipeOnExit: false, privateSignin: true },
  afk: { interval: 30, forward: false, head: true, swing: true, jump: true, chat: false, message: '' },
  reconnect: { delay: 5 },
  warlock: { on: false, command: '/server warlock', delay: 3 },
  join: { text: '' },
  spam: { text: '', delay: 480, ids: null },
  chat: { ids: null },
  proxies: { text: '' },
  move: { forward: false, back: false, left: false, right: false, jump: false, sprint: false },
  accounts: [],
};
let win, cfg, spamTimer = null;
const sessions = new Map();
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const authDir = id => path.join(app.getPath('userData'), 'auth', String(id));
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
const wipeAuth = () => fs.rmSync(path.join(app.getPath('userData'), 'auth'), { recursive: true, force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function load() {
  let saved = {};
  if (fs.existsSync(cfgFile())) {
    try { saved = readJson(cfgFile()); }
    catch (e) {
      // Config got corrupted (e.g. PC lost power mid-save) - fall back to the last good copy instead of losing every account
      log.error('config.json unreadable, trying backup:', e.message);
      try { saved = readJson(cfgFile() + '.bak'); } catch { saved = {}; }
      try { fs.copyFileSync(cfgFile(), cfgFile() + '.corrupt'); } catch {}
    }
  }
  cfg = {};
  for (const k in defaults) {
    const v = saved[k];
    cfg[k] = Array.isArray(defaults[k]) ? (Array.isArray(v) ? v : []) : { ...defaults[k], ...(v && typeof v === 'object' ? v : {}) };
  }
}
// Write to a temp file then swap it in, so a crash mid-save can never leave a half-written config
function save() {
  try {
    const f = cfgFile(), tmp = f + '.tmp';
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    if (fs.existsSync(f)) { try { fs.copyFileSync(f, f + '.bak'); } catch {} }
    fs.renameSync(tmp, f);
  } catch (e) { log.error('Could not save config:', e); }
}
const sess = id => { if (!sessions.has(id)) sessions.set(id, { bot: null, state: 'offline', wanted: false, retries: 0, timers: [], idx: 0 }); return sessions.get(id); };
const pushStatus = () => send('status', Object.fromEntries(cfg.accounts.map(a => [a.id, sess(a.id).state])));
const chatLine = (name, text) => send('chat', { name, text });
const clear = s => { s.timers.forEach(t => { clearTimeout(t); clearInterval(t); }); s.timers = []; };

// Opens a URL in a private/incognito window on Windows so each sign-in starts fresh
function openUrl(url) {
  if (!(cfg.opt.privateSignin && process.platform === 'win32')) return shell.openExternal(url);
  const browsers = [['msedge', '--inprivate'], ['chrome', '--incognito'], ['firefox', '-private-window']];
  const next = i => {
    if (i >= browsers.length) return shell.openExternal(url);
    const c = spawn('cmd.exe', ['/c', 'start', '', browsers[i][0], browsers[i][1], url], { windowsHide: true, stdio: 'ignore' });
    c.on('error', () => next(i + 1));
    c.on('exit', code => { if (code !== 0) next(i + 1); });
  };
  next(0);
}
// Opens the Microsoft sign-in page with the code already filled in, and copies it as a backup
function openCode(d, label) {
  const url = d.verification_uri_complete ||
    (d.verification_uri + (d.verification_uri.includes('?') ? '&' : '?') + 'otc=' + d.user_code);
  clipboard.writeText(d.user_code);
  openUrl(url);
  send('msa', { name: label, uri: url, code: d.user_code });
}
let adding = false;

function proxyFor(i) {
  const list = cfg.proxies.text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!list.length) return null;
  const [host, port, userId, password] = list[i % list.length].split(':');
  return { host, port: parseInt(port), type: 5, userId, password };
}

function applyControls(bot) {
  for (const k in cfg.move) bot.setControlState(k, !!cfg.move[k]);
  bot.setControlState('sneak', !!cfg.opt.sneak);
}

function connectAcc(acc) {
  const s = sess(acc.id);
  if (s.bot || !s.wanted) return;
  const [host, port] = cfg.server.host.trim().split(':');
  const portNum = parseInt(port) || 25565;
  s.state = 'connecting'; s.signin = false; pushStatus();
  chatLine(acc.name, 'Connecting...');
  const opts = {
    host, port: portNum, username: acc.key || acc.name, auth: acc.offline ? 'offline' : 'microsoft',
    version: cfg.server.version || undefined, hideErrors: true,
  };
  if (!acc.offline) {
    opts.profilesFolder = authDir(acc.id);
    fs.mkdirSync(opts.profilesFolder, { recursive: true });
    opts.onMsaCode = d => { s.signin = true; openCode(d, acc.name); };
  }
  const px = proxyFor(s.idx);
  if (px) {
    opts.connect = client => {
      SocksClient.createConnection({ proxy: px, command: 'connect', destination: { host, port: portNum } })
        .then(({ socket }) => { client.setSocket(socket); client.emit('connect'); })
        .catch(e => client.emit('error', e));
    };
  }
  let bot;
  try { bot = mineflayer.createBot(opts); } catch (e) { chatLine(acc.name, 'Error: ' + e.message); s.state = 'offline'; pushStatus(); return retry(acc); }
  s.bot = bot;
  let ended = false;
  // Called once per bot no matter how it dies (end / error / timeout), so we never schedule two reconnects
  const finish = why => {
    if (ended) return; ended = true;
    if (s.bot !== bot) return; // this bot was already stopped or replaced - ignore its late events
    clear(s); s.bot = null; s.state = 'offline'; pushStatus();
    chatLine(acc.name, why || 'Disconnected.');
    try { bot.removeAllListeners('message'); bot.end(); } catch {}
    retry(acc);
  };
  // If the server/proxy never answers, mineflayer can sit at "connecting" forever - give up after 60s and retry
  s.timers.push(setTimeout(() => { if (s.bot === bot && s.state === 'connecting' && !s.signin) finish('Connection timed out.'); }, 60000));
  bot.once('spawn', async () => {
    s.state = 'online'; s.retries = 0; pushStatus();
    chatLine(acc.name, 'Spawned.');
    try { bot.physicsEnabled = !!cfg.opt.physics; applyControls(bot); } catch {}
    const joins = cfg.join.text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const m of joins) { await sleep(1500); if (s.bot === bot) safeChat(bot, m); }
    if (cfg.opt.antiAfk && s.bot === bot) antiAfk(s, bot);
  });
  s.warlock = warlockMode(acc, s, bot);
  bot.on('message', m => { try { chatLine(acc.name, m.toString()); } catch {} });
  bot.on('kicked', r => chatLine(acc.name, 'Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r))));
  bot.on('error', e => { chatLine(acc.name, 'Error: ' + (e && e.message)); log.warn(acc.name, 'bot error:', e && e.message); if (s.state === 'connecting') finish('Disconnected.'); });
  bot.on('end', () => finish());
}

const safeChat = (bot, text) => { try { bot.chat(text); } catch (e) { log.warn('chat failed:', e.message); } };

// ---------- Warlock mode ----------
// Every time an alt lands in the hub (first join, or sent back for any reason) it sends the command ONCE.
// The proxy moving an alt between servers shows up as a "world change" (login/respawn packet), so:
//   hub -> we send the command -> next world change = arrived in warlock (don't send again)
//   in warlock -> unexpected world change = got sent to hub -> send the command once
// If the command doesn't move the alt (warlock restarting/full), it tries again every 45s until it does.
function warlockMode(acc, s, bot) {
  let state = 'hub', sendTimer = null, retryTimer = null, lastChange = 0, died = false, spawned = false;
  const alive = () => s.bot === bot;
  const stopTimers = () => { clearTimeout(sendTimer); clearTimeout(retryTimer); sendTimer = retryTimer = null; };
  const send = () => {
    stopTimers();
    if (!alive() || !cfg.warlock.on) return;
    const cmd = (cfg.warlock.command || '/server warlock').trim();
    safeChat(bot, cmd);
    chatLine(acc.name, 'Warlock mode: sent ' + cmd);
    state = 'expect';
    retryTimer = setTimeout(() => {
      if (alive() && state === 'expect') { chatLine(acc.name, 'Warlock mode: still not moved, trying again...'); send(); }
    }, 45000);
    s.timers.push(retryTimer);
  };
  const queueSend = () => {
    if (!cfg.warlock.on) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(send, Math.max(1, Number(cfg.warlock.delay) || 3) * 1000);
    s.timers.push(sendTimer);
  };
  const worldChanged = () => {
    if (!spawned) return;
    const now = Date.now();
    if (now - lastChange < 3000) return; // one server switch can send 2 packets
    lastChange = now;
    if (state === 'expect') { stopTimers(); state = 'warlock'; chatLine(acc.name, 'Warlock mode: joined warlock.'); return; }
    state = 'hub';
    if (cfg.warlock.on) chatLine(acc.name, 'Warlock mode: sent to hub - rejoining warlock.');
    queueSend();
  };
  bot.once('spawn', () => { spawned = true; lastChange = Date.now(); state = 'hub'; queueSend(); });
  bot.on('death', () => { died = true; });
  bot._client.on('login', worldChanged);
  bot._client.on('respawn', () => { if (died) { died = false; return; } worldChanged(); }); // dying also sends respawn - ignore it
  bot.on('messagestr', m => {
    if (state === 'expect' && /already connected/i.test(m)) { stopTimers(); state = 'warlock'; }
  });
  // Turning the mode on while alts are already online: send once (harmless "already connected" if they're there)
  return { enable: () => { if (spawned && alive() && state !== 'expect') { state = 'hub'; queueSend(); } } };
}

function retry(acc) {
  const s = sess(acc.id);
  if (!s.wanted || !(cfg.opt.reconnect || cfg.warlock.on)) { s.wanted = false; return; } // warlock mode always keeps alts online
  if (!cfg.accounts.some(a => a.id === acc.id)) { s.wanted = false; return; } // account was removed
  s.retries++;
  // Back off when a server keeps refusing us: base, 2x, 4x... capped at 60 seconds, plus a little jitter
  const base = Math.max(1, Number(cfg.reconnect.delay) || 5) * 1000;
  const delay = Math.min(base * 2 ** Math.min(s.retries - 1, 6), Math.max(base, 60000)) + Math.random() * 1000;
  s.state = 'waiting'; pushStatus();
  chatLine(acc.name, `Reconnecting in ${Math.round(delay / 1000)}s...` + (s.retries > 1 ? ` (attempt ${s.retries})` : ''));
  s.timers.push(setTimeout(() => connectAcc(acc), delay));
}

function antiAfk(s, bot) {
  const tick = () => {
    if (s.bot !== bot) return;
    const a = cfg.afk;
    try {
      if (a.head) bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
      if (a.jump && !cfg.move.jump) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 300); }
      if (a.swing) bot.swingArm();
      if (a.forward && !cfg.move.forward) { bot.setControlState('forward', true); setTimeout(() => bot.setControlState('forward', false), 400); }
      if (a.chat && a.message) bot.chat(a.message);
    } catch {}
    s.timers.push(setTimeout(tick, schedule()));
  };
  const schedule = () => Math.max(1, Number(cfg.afk.interval) || 30) * 1000 * (0.85 + Math.random() * 0.3);
  s.timers.push(setTimeout(tick, schedule()));
}

function stopAcc(id) {
  const s = sess(id);
  s.wanted = false; clear(s);
  if (s.bot) { try { s.bot.quit(); } catch {} }
  s.bot = null; s.state = 'offline';
}
const onlineFor = ids => cfg.accounts.filter(a => (ids === null || ids === undefined || ids.includes(a.id)) && sess(a.id).state === 'online');
const accounts = () => cfg.accounts;

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
  load(); createWindow(); setupUpdater();

  ipcMain.handle('version', () => app.getVersion());
  ipcMain.handle('updateState', () => updateState);
  ipcMain.handle('installUpdate', () => {
    if (updateState.status !== 'ready') return;
    cfg.accounts.forEach(a => stopAcc(a.id));
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent install, then relaunch
  });

  ipcMain.handle('get', () => cfg);
  ipcMain.handle('status', () => Object.fromEntries(cfg.accounts.map(a => [a.id, sess(a.id).state])));
  ipcMain.handle('set', (_, key, val) => {
    const parts = String(key).split('.'); let o = cfg;
    while (parts.length > 1) { const p = parts.shift(); if (!o[p] || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
    o[parts[0]] = val; save();
    if (key.startsWith('move.') || key === 'opt.sneak') sessions.forEach(s => s.bot && applyControls(s.bot));
    if (key === 'warlock.on' && val) sessions.forEach(s => s.bot && s.warlock && s.warlock.enable());
    if (key === 'opt.physics') sessions.forEach(s => { if (s.bot) s.bot.physicsEnabled = !!val; });
  });
  ipcMain.handle('addMicrosoft', async () => {
    if (adding) return { ok: false, error: 'Already waiting for a sign-in.' };
    adding = true;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const dir = authDir(id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const flow = new Authflow(id, dir, { authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo', flow: 'live' }, d => openCode(d, 'New account'));
      const r = await flow.getMinecraftJavaToken({ fetchProfile: true });
      const prof = r && r.profile;
      if (!prof || !prof.name) throw new Error('That Microsoft account does not own Minecraft Java Edition.');
      if (cfg.accounts.some(a => a.uuid === prof.id || a.name.toLowerCase() === prof.name.toLowerCase())) throw new Error(prof.name + ' is already added. Your browser signed in to the same account again - use a private window or pick a different account.');
      cfg.accounts.push({ id, key: id, name: prof.name, uuid: prof.id, offline: false, selected: true });
      save();
      return { ok: true, name: prof.name, accounts: cfg.accounts };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: e.message };
    } finally { adding = false; }
  });
  ipcMain.handle('add', (_, name, offline) => {
    name = (name || '').trim();
    if (!name) return accounts();
    cfg.accounts.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, offline: !!offline, selected: true });
    save(); return accounts();
  });
  ipcMain.handle('selectAll', (_, v) => { cfg.accounts.forEach(a => a.selected = v); save(); return accounts(); });
  ipcMain.handle('remove', (_, id) => { stopAcc(id); fs.rmSync(authDir(id), { recursive: true, force: true }); cfg.accounts = cfg.accounts.filter(a => a.id !== id); sessions.delete(id);
    ['chat', 'spam'].forEach(k => { if (cfg[k].ids) cfg[k].ids = cfg[k].ids.filter(x => x !== id); }); save(); return accounts(); });
  ipcMain.handle('select', (_, id, v) => { const a = cfg.accounts.find(a => a.id === id); if (a) a.selected = v; save(); return accounts(); });
  ipcMain.handle('clear', () => { cfg.accounts.forEach(a => stopAcc(a.id)); wipeAuth(); cfg.accounts = []; sessions.clear(); cfg.chat.ids = cfg.spam.ids = null; save(); return accounts(); });
  ipcMain.handle('clearCache', () => {
    cfg.accounts.forEach(a => stopAcc(a.id)); cfg.accounts = []; sessions.clear(); cfg.chat.ids = cfg.spam.ids = null; save();
    fs.rmSync(path.join(app.getPath('userData'), 'auth'), { recursive: true, force: true });
    return accounts();
  });
  ipcMain.handle('disconnectSelected', () => { cfg.accounts.filter(a => a.selected).forEach(a => stopAcc(a.id)); pushStatus(); });
  ipcMain.handle('toggle', (_, id) => {
    const a = cfg.accounts.find(x => x.id === id);
    if (!a) return 'No such account.';
    const s = sess(id);
    if (s.wanted || s.bot) { stopAcc(id); chatLine(a.name, 'Stopped.'); pushStatus(); return 'stopped'; }
    if (!cfg.server.host.trim()) return 'Enter a server IP first.';
    s.wanted = true; s.idx = cfg.accounts.indexOf(a); s.retries = 0;
    connectAcc(a);
    return 'started';
  });
  ipcMain.handle('wipeAll', async () => {
    cfg.accounts.forEach(a => stopAcc(a.id));
    sessions.clear(); clearInterval(spamTimer); spamTimer = null;
    wipeAuth(); fs.rmSync(cfgFile(), { force: true });
    try { await win.webContents.session.clearStorageData(); await win.webContents.session.clearCache(); } catch {}
    load(); win.reload();
  });
  ipcMain.handle('connect', () => {
    if (!cfg.server.host.trim()) return 'Enter a server IP first.';
    cfg.accounts.filter(a => a.selected).forEach((a, i) => {
      const s = sess(a.id);
      if (s.bot || s.wanted) return;
      s.wanted = true; s.idx = i; s.retries = 0;
      s.timers.push(setTimeout(() => connectAcc(a), i * (cfg.server.delay || 0) * 1000));
    });
    return 'ok';
  });
  ipcMain.handle('disconnect', () => { cfg.accounts.forEach(a => stopAcc(a.id)); pushStatus(); });
  ipcMain.handle('say', (_, text) => { if (text) onlineFor(cfg.chat.ids).forEach(a => safeChat(sess(a.id).bot, text)); });
  ipcMain.handle('spam', (_, on) => {
    clearInterval(spamTimer); spamTimer = null;
    if (!on) return;
    let running = false;
    const run = async () => {
      if (running) return; running = true;
      try {
      const msgs = cfg.spam.text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const m of msgs) { onlineFor(cfg.spam.ids).forEach(a => safeChat(sess(a.id).bot, m)); await sleep(1500); }
      } finally { running = false; }
    };
    run(); spamTimer = setInterval(run, Math.max(1, cfg.spam.delay) * 1000);
  });
  ipcMain.handle('openLink', (_, url) => openUrl(url));
});
app.on('before-quit', () => {
  // Disconnect bots cleanly so servers don't see a timeout/ghost player
  if (cfg) cfg.accounts.forEach(a => { try { stopAcc(a.id); } catch {} });
  clearInterval(spamTimer);
});
app.on('will-quit', () => {
  if (cfg && cfg.opt.wipeOnExit) {
    try { wipeAuth(); fs.rmSync(cfgFile(), { force: true }); } catch {}
  }
});
app.on('window-all-closed', () => app.quit());
