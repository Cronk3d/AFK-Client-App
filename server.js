// Web version: runs the bots on a server (e.g. a VPS) 24/7 and serves the same UI to your browser.
//   AFK_PASSWORD=yourpassword node server.js
// Env: AFK_PASSWORD (required), PORT (default 3000), HOST (default 127.0.0.1 - put Caddy/HTTPS in front),
//      DATA_DIR (default ./data)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const createCore = require('./core');

const PASSWORD = process.env.AFK_PASSWORD || '';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const VERSION = require('./package.json').version;
if (PASSWORD.length < 8) { console.error('Set AFK_PASSWORD (at least 8 characters) before starting.'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (...a) => console.log(ts(), '[info]', ...a),
  warn: (...a) => console.warn(ts(), '[warn]', ...a),
  error: (...a) => console.error(ts(), '[error]', ...a),
};
process.on('uncaughtException', e => log.error('Uncaught exception:', e));
process.on('unhandledRejection', e => log.error('Unhandled rejection:', e));

// ---------- Login sessions (signed cookie, survives restarts) ----------
const secretFile = path.join(DATA_DIR, '.session-secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
// Changing AFK_PASSWORD logs everyone out, because the password is part of the signing key
const SECRET = fs.readFileSync(secretFile, 'utf8').trim() + ':' + crypto.createHash('sha256').update(PASSWORD).digest('hex');
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const SESSION_DAYS = 30;
const makeToken = () => { const exp = String(Date.now() + SESSION_DAYS * 864e5); return exp + '.' + sign(exp); };
const validToken = t => {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = sign(exp);
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p[0]));
const authed = req => validToken(cookies(req).afk);
const passOk = p => { const a = crypto.createHash('sha256').update(String(p)).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest(); return crypto.timingSafeEqual(a, b); };

// Slow down password guessing: 10 tries per 15 minutes per IP
const attempts = new Map();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const limited = ip => { const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3); attempts.set(ip, a); return a.length >= 10; };

// ---------- Core + live connections ----------
const clients = new Set();
const history = []; // last chat lines, so a newly opened page sees recent activity
const broadcast = (ch, data) => {
  if (ch === 'chat') { history.push({ ...data, at: Date.now() }); if (history.length > 500) history.shift(); }
  const msg = JSON.stringify({ ev: ch, data });
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
};
const core = createCore({ dataDir: DATA_DIR, send: broadcast, log, afterWipe: () => broadcast('reload') });
const extra = {
  version: () => VERSION,
  updateState: () => ({ status: 'idle' }),
  installUpdate: () => {},
  isWeb: () => true,
};

// ---------- HTTP ----------
const loginPage = err => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skyblocker AFK Client</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e9edf1;font:14px 'Segoe UI',system-ui,sans-serif}
form{background:#151a20;border:1px solid #232b34;border-radius:14px;padding:28px;width:320px;max-width:calc(100vw - 32px);box-sizing:border-box}
h1{font-size:18px;margin:0 0 18px;display:flex;align-items:center;gap:10px}img{width:30px}
input{width:100%;box-sizing:border-box;background:#0e1217;border:1px solid #232b34;border-radius:8px;color:#e9edf1;padding:10px 12px;font:inherit;margin-bottom:12px}
button{width:100%;border:0;background:#16a34a;color:#fff;padding:10px;border-radius:8px;font:600 14px inherit;cursor:pointer}.e{color:#ef4444;margin:-4px 0 12px}</style></head>
<body><form method="post" action="/login"><h1><img src="/logo.png" alt="">Skyblocker AFK Client</h1>${err ? `<div class="e">${err}</div>` : ''}
<input type="password" name="password" placeholder="Password" autofocus required><button>Sign in</button></form></body></html>`;

const indexHtml = () => fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace('<head>', '<head><meta name="viewport" content="width=device-width,initial-scale=1">')
  .replace('<script>', '<script src="/web-api.js"></script>\n<script>');
const statics = { '/logo.png': 'image/png', '/icon.png': 'image/png', '/web-api.js': 'application/javascript' };
const secure = req => req.headers['x-forwarded-proto'] === 'https';
const setCookie = (req, val, maxAge) => `afk=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname === '/logo.png' || url.pathname === '/icon.png' || (url.pathname === '/web-api.js' && authed(req))) {
    res.writeHead(200, { 'Content-Type': statics[url.pathname], 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, url.pathname.slice(1))).pipe(res);
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (limited(ip)) { res.writeHead(429, { 'Content-Type': 'text/html' }); return res.end(loginPage('Too many tries. Wait 15 minutes.')); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(body).get('password') || '';
      if (passOk(pw)) {
        attempts.delete(ip);
        res.writeHead(303, { Location: '/', 'Set-Cookie': setCookie(req, makeToken(), SESSION_DAYS * 86400) });
        return res.end();
      }
      attempts.get(ip).push(Date.now());
      log.warn('Failed login from', ip);
      res.writeHead(401, { 'Content-Type': 'text/html' }); res.end(loginPage('Wrong password.'));
    });
    return;
  }
  if (url.pathname === '/logout') { res.writeHead(303, { Location: '/', 'Set-Cookie': setCookie(req, '', 0) }); return res.end(); }
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (!authed(req)) { res.writeHead(url.pathname === '/' ? 200 : 401, { 'Content-Type': 'text/html' }); return res.end(loginPage()); }
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(indexHtml()); }
  res.writeHead(404); res.end('Not found');
});

// ---------- WebSocket: same calls as the desktop app's ipc ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin, host = req.headers.host;
  const sameOrigin = origin && host && new URL(origin).host === host;
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !authed(req) || !sameOrigin) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ ev: 'history', data: history }));
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const fn = core.handlers[m.ch] || extra[m.ch];
    let result, error;
    if (!fn) error = 'Unknown call: ' + m.ch;
    else { try { result = await fn(...(Array.isArray(m.args) ? m.args : [])); } catch (e) { error = e.message; log.error('Call', m.ch, 'failed:', e); } }
    if (ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, result, error }));
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});
// Drop dead browser connections
setInterval(() => { for (const ws of clients) { if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 30000);

server.listen(PORT, HOST, () => {
  log.info(`AFK Client web v${VERSION} on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  core.resume(); // bring back every alt that was online before the restart
});

// Clean shutdown (systemd stop/restart, Ctrl+C): disconnect bots but remember they should come back
const shutdown = sig => {
  log.info(`${sig} - disconnecting bots`);
  core.stopAll(false);
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
