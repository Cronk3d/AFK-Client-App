const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path'), fs = require('fs');
const { spawn } = require('child_process');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { Authflow, Titles } = require('prismarine-auth');

// Keep saved accounts/settings in one fixed folder, whether run from npm or the installed app
app.setPath('userData', path.join(app.getPath('appData'), 'my-afk-client'));

const defaults = {
  server: { host: '', version: '', delay: 5 },
  opt: { sneak: false, physics: true, antiAfk: true, reconnect: true, wipeOnExit: false, privateSignin: true },
  afk: { interval: 30, forward: false, head: true, swing: true, jump: true, chat: false, message: '' },
  reconnect: { delay: 5 },
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

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch {}
  cfg = {};
  for (const k in defaults) cfg[k] = Array.isArray(defaults[k]) ? (saved[k] || []) : { ...defaults[k], ...(saved[k] || {}) };
}
const save = () => { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); };
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
  s.state = 'connecting'; pushStatus();
  chatLine(acc.name, 'Connecting...');
  const opts = {
    host, port: portNum, username: acc.key || acc.name, auth: acc.offline ? 'offline' : 'microsoft',
    version: cfg.server.version || undefined, hideErrors: true,
  };
  if (!acc.offline) {
    opts.profilesFolder = authDir(acc.id);
    fs.mkdirSync(opts.profilesFolder, { recursive: true });
    opts.onMsaCode = d => openCode(d, acc.name);
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
  try { bot = mineflayer.createBot(opts); } catch (e) { chatLine(acc.name, 'Error: ' + e.message); s.state = 'offline'; return retry(acc); }
  s.bot = bot;
  bot.once('spawn', async () => {
    s.state = 'online'; s.retries = 0; pushStatus();
    chatLine(acc.name, 'Spawned.');
    bot.physicsEnabled = !!cfg.opt.physics;
    applyControls(bot);
    const joins = cfg.join.text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const m of joins) { await sleep(1500); if (s.bot === bot) bot.chat(m); }
    if (cfg.opt.antiAfk) antiAfk(s, bot);
  });
  bot.on('message', m => chatLine(acc.name, m.toString()));
  bot.on('kicked', r => chatLine(acc.name, 'Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r))));
  bot.on('error', e => chatLine(acc.name, 'Error: ' + e.message));
  bot.on('end', () => {
    clear(s); s.bot = null; s.state = 'offline'; pushStatus();
    chatLine(acc.name, 'Disconnected.');
    retry(acc);
  });
}

function retry(acc) {
  const s = sess(acc.id);
  if (!s.wanted || !cfg.opt.reconnect) { s.wanted = false; return; }
  s.retries++;
  const delay = Math.max(1, Number(cfg.reconnect.delay) || 5) * 1000;
  s.state = 'waiting'; pushStatus();
  chatLine(acc.name, `Reconnecting in ${Math.round(delay / 1000)}s...`);
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
}

app.whenReady().then(() => {
  load(); createWindow();

  ipcMain.handle('get', () => cfg);
  ipcMain.handle('status', () => Object.fromEntries(cfg.accounts.map(a => [a.id, sess(a.id).state])));
  ipcMain.handle('set', (_, key, val) => {
    const parts = key.split('.'); let o = cfg;
    while (parts.length > 1) o = o[parts.shift()];
    o[parts[0]] = val; save();
    if (key.startsWith('move.') || key === 'opt.sneak') sessions.forEach(s => s.bot && applyControls(s.bot));
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
  ipcMain.handle('say', (_, text) => { if (text) onlineFor(cfg.chat.ids).forEach(a => sess(a.id).bot.chat(text)); });
  ipcMain.handle('spam', (_, on) => {
    clearInterval(spamTimer); spamTimer = null;
    if (!on) return;
    const run = async () => {
      const msgs = cfg.spam.text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const m of msgs) { onlineFor(cfg.spam.ids).forEach(a => sess(a.id).bot.chat(m)); await sleep(1500); }
    };
    run(); spamTimer = setInterval(run, Math.max(1, cfg.spam.delay) * 1000);
  });
  ipcMain.handle('openLink', (_, url) => openUrl(url));
});
app.on('will-quit', () => {
  if (cfg && cfg.opt.wipeOnExit) {
    cfg.accounts.forEach(a => stopAcc(a.id));
    try { wipeAuth(); fs.rmSync(cfgFile(), { force: true }); } catch {}
  }
});
app.on('window-all-closed', () => app.quit());
