// Disney Watch Party: syncs the Disney+ <video> between two browsers over a
// direct peer-to-peer link (PeerJS / WebRTC). No server of ours, no account.
(() => {
  if (window.__hwpLoaded) return;
  window.__hwpLoaded = true;

  const PREFIX = 'hunty-watch-party-';
  const DRIFT_SECONDS = 1.5;
  const TICK_MS = 4000;
  const STORE_KEY = 'hwp-session';

  let peer = null;
  let conn = null;
  let role = null; // 'host' | 'guest'
  let code = null;
  let suppressUntil = 0; // ignore our own video events until this timestamp
  let currentVideo = null;
  let lastUrl = location.href;
  let tickTimer = null;

  // ---------- UI ----------
  const panel = document.createElement('div');
  panel.id = 'hwp-panel';
  panel.innerHTML = `
    <div class="hwp-head"><span>Watch Party</span><span class="hwp-min">hide</span></div>
    <div class="hwp-body"></div>`;
  document.documentElement.appendChild(panel);
  const body = panel.querySelector('.hwp-body');
  const SIDEBAR_PX = 320;
  const layoutStyle = document.createElement('style');
  layoutStyle.id = 'hwp-layout';
  layoutStyle.textContent = `
    html, body, #root, #dplus-app-element, [class*="video_view"], [class*="hudson-contain"],
    [class*="player-container-root"], .mini-player-bounds, draggable-surface, .mini-player-inner,
    .btm-media-player, .btm-media-clients, .media-element-container, video.hive-video {
      width: calc(100vw - ${SIDEBAR_PX}px) !important;
      max-width: calc(100vw - ${SIDEBAR_PX}px) !important;
    }`;
  function applyLayout() {
    const open = !panel.classList.contains('hwp-collapsed') && !document.fullscreenElement;
    if (open && !layoutStyle.isConnected) document.documentElement.appendChild(layoutStyle);
    if (!open && layoutStyle.isConnected) layoutStyle.remove();
    if (open) window.dispatchEvent(new Event('resize'));
  }
  panel.querySelector('.hwp-head').addEventListener('click', () => {
    panel.classList.toggle('hwp-collapsed');
    panel.querySelector('.hwp-min').textContent = panel.classList.contains('hwp-collapsed') ? 'show' : 'hide';
    applyLayout();
  });
  document.addEventListener('fullscreenchange', applyLayout);
  applyLayout();

  function render(state, extra) {
    if (state === 'idle') {
      body.innerHTML = `
        <button id="hwp-host">Start a party</button>
        <input id="hwp-code" maxlength="4" placeholder="CODE">
        <button id="hwp-join" class="hwp-secondary">Join a party</button>
        <div class="hwp-status">Both of you install this. One starts, the other joins with the code.</div>`;
      body.querySelector('#hwp-host').onclick = () => startHost(randomCode());
      body.querySelector('#hwp-join').onclick = () => {
        const v = body.querySelector('#hwp-code').value.trim().toUpperCase();
        if (v.length === 4) startGuest(v);
      };
      body.querySelector('#hwp-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') body.querySelector('#hwp-join').click();
        e.stopPropagation();
      });
    } else if (state === 'hosting') {
      body.innerHTML = `
        <div class="hwp-status">Send this code:</div>
        <div class="hwp-code">${code}</div>
        <div class="hwp-status ${conn ? 'hwp-ok' : ''}">${conn ? 'Connected. You are in sync.' : 'Waiting for them to join...'}</div>
        ${conn ? chatHtml() : ''}
        <button id="hwp-leave" class="hwp-secondary">End party</button>`;
      body.querySelector('#hwp-leave').onclick = leave;
      if (conn) wireChat();
    } else if (state === 'joining') {
      body.innerHTML = `
        <div class="hwp-status">Joining ${code}...</div>
        <button id="hwp-leave" class="hwp-secondary">Cancel</button>`;
      body.querySelector('#hwp-leave').onclick = leave;
    } else if (state === 'joined') {
      body.innerHTML = `
        <div class="hwp-status hwp-ok">Connected to ${code}. You are in sync.</div>
        ${chatHtml()}
        <button id="hwp-leave" class="hwp-secondary">Leave party</button>`;
      body.querySelector('#hwp-leave').onclick = leave;
      wireChat();
    } else if (state === 'error') {
      body.innerHTML = `
        <div class="hwp-status hwp-bad">${extra || 'Something went wrong.'}</div>
        <button id="hwp-leave" class="hwp-secondary">Back</button>`;
      body.querySelector('#hwp-leave').onclick = leave;
    }
  }

  // ---------- Chat ----------
  const chatLog = []; // {who, text}
  function chatHtml() {
    return `
      <div id="hwp-chat"></div>
      <input id="hwp-msg" class="hwp-msg" maxlength="500" placeholder="Say something...">`;
  }
  function wireChat() {
    const input = body.querySelector('#hwp-msg');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep Disney+ hotkeys (space = pause) out of the chat box
      if (e.key === 'Enter' && input.value.trim()) {
        const text = input.value.trim();
        input.value = '';
        addChat('You', text);
        send({ type: 'chat', text });
      }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    drawChat();
  }
  function addChat(who, text) {
    chatLog.push({ who, text });
    if (chatLog.length > 200) chatLog.shift();
    drawChat();
    if (who !== 'You') flashPanel();
  }
  function drawChat() {
    const el = body.querySelector('#hwp-chat');
    if (!el) return;
    el.textContent = '';
    for (const m of chatLog) {
      const line = document.createElement('div');
      line.className = 'hwp-line' + (m.who === 'You' ? ' hwp-me' : '');
      const who = document.createElement('b');
      who.textContent = m.who + ': ';
      line.appendChild(who);
      line.appendChild(document.createTextNode(m.text));
      el.appendChild(line);
    }
    el.scrollTop = el.scrollHeight;
  }
  function flashPanel() {
    if (panel.classList.contains('hwp-collapsed')) {
      panel.querySelector('.hwp-min').textContent = 'new message';
    }
  }

  function randomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // ---------- Peer plumbing ----------
  function newPeer(id) {
    // Public PeerJS signaling server; media never touches it, only the handshake.
    return id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
  }

  function startHost(c) {
    code = c;
    role = 'host';
    saveSession();
    render('hosting');
    peer = newPeer(PREFIX + code);
    peer.on('open', () => render('hosting'));
    peer.on('connection', (c2) => {
      if (conn) { try { conn.close(); } catch (_) {} }
      wireConn(c2);
      c2.on('open', () => {
        render('hosting');
        sendState('sync');
      });
    });
    peer.on('error', (e) => onPeerError(e));
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (_) {} });
  }

  function startGuest(c) {
    code = c;
    role = 'guest';
    saveSession();
    render('joining');
    peer = newPeer();
    peer.on('open', () => {
      const c2 = peer.connect(PREFIX + code, { reliable: true });
      wireConn(c2);
      c2.on('open', () => render('joined'));
    });
    peer.on('error', (e) => onPeerError(e));
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (_) {} });
  }

  function onPeerError(e) {
    const t = (e && e.type) || '';
    if (t === 'unavailable-id') render('error', 'That code is already in use. Start a new party.');
    else if (t === 'peer-unavailable') render('error', 'No party with that code. Check the code and that they pressed Start.');
    else if (t === 'network' || t === 'server-error') render('error', 'Could not reach the signaling server. Try again in a moment.');
    else render('error', 'Connection error: ' + t);
  }

  function wireConn(c2) {
    conn = c2;
    c2.on('data', onMessage);
    c2.on('close', () => {
      conn = null;
      if (role === 'host') render('hosting');
      else if (role === 'guest') render('error', 'The host left the party.');
    });
    c2.on('error', () => {});
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => { if (role === 'host') sendState('tick'); }, TICK_MS);
  }

  function leave() {
    sessionStorage.removeItem(STORE_KEY);
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    try { if (conn) conn.close(); } catch (_) {}
    try { if (peer) peer.destroy(); } catch (_) {}
    conn = null; peer = null; role = null; code = null;
    render('idle');
  }

  function saveSession() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ role, code })); } catch (_) {}
  }

  function send(msg) {
    if (conn && conn.open) {
      try { conn.send(msg); } catch (_) {}
    }
  }

  function sendState(type) {
    const v = currentVideo;
    send({
      type,
      time: v ? v.currentTime : 0,
      paused: v ? v.paused : true,
      url: location.href,
    });
  }

  // ---------- Applying remote state ----------
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'chat') {
      if (typeof msg.text === 'string') addChat('Them', msg.text.slice(0, 500));
      return;
    }

    // Follow the host to the same title.
    if (role === 'guest' && msg.url && samePlayerPath(msg.url) === false) {
      saveSession();
      location.href = msg.url; // full reload; we auto-rejoin from sessionStorage
      return;
    }

    const v = currentVideo;
    if (!v) return;

    if (msg.type === 'play') {
      quietly(() => { seekIfFar(v, msg.time); v.play().catch(() => {}); });
    } else if (msg.type === 'pause') {
      quietly(() => { v.pause(); seekIfFar(v, msg.time, 0.3); });
    } else if (msg.type === 'seek') {
      quietly(() => { v.currentTime = msg.time; if (!msg.paused) v.play().catch(() => {}); });
    } else if (msg.type === 'sync' || msg.type === 'tick') {
      quietly(() => {
        seekIfFar(v, msg.time);
        if (msg.paused && !v.paused) v.pause();
        if (!msg.paused && v.paused) v.play().catch(() => {});
      });
    }
  }

  function samePlayerPath(url) {
    try {
      const a = new URL(url), b = new URL(location.href);
      // Only care about the video page itself, e.g. /play/<id> or /video/<id>
      const isPlayer = (u) => /\/(play|video)\//.test(u.pathname);
      if (!isPlayer(a)) return true; // host is browsing, do not drag the guest around
      return a.pathname === b.pathname;
    } catch (_) { return true; }
  }

  function seekIfFar(v, time, tolerance = DRIFT_SECONDS) {
    if (typeof time !== 'number' || !isFinite(time)) return;
    if (Math.abs(v.currentTime - time) > tolerance) v.currentTime = time;
  }

  function quietly(fn) {
    suppressUntil = Date.now() + 800;
    try { fn(); } catch (_) {}
  }

  // ---------- Watching the local video ----------
  function attach(v) {
    if (currentVideo === v) return;
    currentVideo = v;
    v.addEventListener('play', () => { if (Date.now() > suppressUntil) sendState('play'); });
    v.addEventListener('pause', () => { if (Date.now() > suppressUntil) sendState('pause'); });
    v.addEventListener('seeked', () => { if (Date.now() > suppressUntil) sendState('seek'); });
    if (role === 'host') sendState('sync');
  }

  // Disney+ keeps a hidden dummy <video> on the page; pick the visible one that has media loaded.
  function pickVideo() {
    const all = [...document.querySelectorAll('video')];
    const ready = all.filter((v) => v.readyState > 0 && v.offsetWidth > 0 && v.offsetHeight > 0);
    const pool = ready.length ? ready : all.filter((v) => v.offsetWidth > 0);
    if (!pool.length) return null;
    return pool.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
  }

  setInterval(() => {
    const v = pickVideo();
    if (v && v !== currentVideo) attach(v);
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (role === 'host') sendState('sync');
    }
  }, 1000);

  // ---------- Boot ----------
  render('idle');
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.code) {
      if (saved.role === 'host') startHost(saved.code);
      else startGuest(saved.code);
    }
  } catch (_) {}
})();
