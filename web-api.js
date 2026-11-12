// Browser stand-in for the desktop app's preload.js: same window.api, but over a WebSocket to server.js.
(() => {
  const listeners = {}, pending = new Map(), queue = [];
  let ws, nextId = 1, everConnected = false, banner;
  const emit = (ch, d) => (listeners[ch] || []).forEach(cb => { try { cb(d); } catch (e) { console.error(e); } });
  const showBanner = on => {
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#7f1d1d;color:#fff;text-align:center;padding:6px;font:13px system-ui;display:none';
      banner.textContent = 'Lost connection to the server - reconnecting... (your alts keep running)';
      document.body.appendChild(banner);
    }
    banner.style.display = on ? 'block' : 'none';
  };
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      if (everConnected) return location.reload(); // re-sync everything after a drop
      everConnected = true; showBanner(false);
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); } return; }
      if (m.ev === 'reload') return location.reload();
      if (m.ev === 'history') return m.data.forEach(l => emit('chat', l));
      emit(m.ev, m.data);
    };
    ws.onclose = ev => {
      if (document.body) showBanner(true);
      if (ev.code === 1006 && !everConnected) return setTimeout(() => location.reload(), 2000); // probably logged out
      setTimeout(connect, 2000);
    };
  }
  window.api = {
    invoke(ch, ...args) {
      // Links (Microsoft sign-in) open on YOUR device, not on the server
      if (ch === 'openLink') { window.open(args[0], '_blank', 'noopener'); return Promise.resolve(); }
      const id = nextId++;
      const msg = JSON.stringify({ id, ch, args });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws && ws.readyState === 1 ? ws.send(msg) : queue.push(msg);
      });
    },
    on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); },
    isWeb: true,
  };
  connect();
})();
