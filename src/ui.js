// In-page UI (PLAN.md v3 "UI"). The party UI itself lives in Chrome's side panel
// (sidepanel.html); this file is the page half:
//   1. a port ('hwp-page') to background.js, which relays to the side panel bound to this tab:
//      bus events go out as {type:'event'}, chat/system lines as {type:'line'}, view state as
//      {type:'state'}, and a full {type:'snapshot'} answers the panel's {type:'hello'}.
//      Panel commands (set-name, host, join, leave, chat, reaction, control) come back in.
//   2. the chat log (source of truth, so a reopened panel keeps its history; survives a reload
//      of the same party via sessionStorage),
//   3. reaction floats over the video.
// There is nothing else on the page: the chat opens from the toolbar icon.
// Nothing here resizes or restyles Disney+'s own layout. User text is only ever set with textContent.
(() => {
  if (!window.HWP || HWP.ui) return;

  const MAX_LINES = 300;
  const EMOJIS = ['😂', '❤️', '😭', '🔥', '👀', '🍿'];
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I lookalikes
  const PING_MS = 20000;            // keeps the MV3 service worker (and so the relay) alive
  const LOG_KEY = 'hwp-log';
  // net:message types the panel cares about (ticks/play/pause/seek stay in the page).
  const FWD_MESSAGES = new Set(['chat', 'gif', 'msg-react', 'reaction', 'control', 'welcome', 'roster', 'end']);
  // Bus events forwarded verbatim to the panel.
  const FWD_EVENTS = ['net:status', 'net:roster', 'sync:event', 'sync:ad', 'sync:waiting', 'player:ready', 'player:gone'];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const sess = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (_) {} },
  };

  // ---------- state ----------
  let inited = false;
  let port = null, portDead = false, retryMs = 1000, retryTimer = null;
  let panelCount = 0;              // side panels currently bound to this tab (from background.js)
  let status = { state: 'idle', peerCount: 0 };
  let log = [], nextId = 1, saveTimer = null;
  let unread = 0;
  let roster = [];                 // names of the others (net:roster)
  let rosterPrimed = false;        // guests: the first roster is "who's here", not a stream of "X joined"
  let hostName = '';               // learned from the host's welcome
  let waiting = [];                // sync:waiting names (whose ad the room is waiting on)
  let adMe = false;                // an ad is on my screen
  let playerReady = null;          // player:ready / player:gone, null = not reported yet
  let lastReactAt = 0;
  let floats = null;

  // ---------- helpers ----------
  // Tiny element builder. Props go to DOM properties when they exist, else attributes. Never parses HTML.
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const k in props || {}) {
      if (k === 'text') n.textContent = props[k];
      else if (k in n) n[k] = props[k];
      else n.setAttribute(k, props[k]);
    }
    n.append(...kids.filter(Boolean));
    return n;
  }
  // GIFs come only from Tenor (what the panel's GIF search returns); anything else is dropped on both ends.
  function gifUrl(u) {
    if (typeof u !== 'string' || u.length > 500) return null;
    try {
      const x = new URL(u);
      if (x.protocol !== 'https:' || !(x.hostname === 'tenor.com' || x.hostname.endsWith('.tenor.com'))) return null;
      return x.href;
    } catch (_) { return null; }
  }
  // Chat and gif messages carry a shared id (mid) so a reaction on one side finds the same line on the other.
  const newMid = () => { const r = crypto.getRandomValues(new Uint32Array(2)); return r[0].toString(36) + r[1].toString(36); };
  const cleanMid = (m) => (typeof m === 'string' && /^[a-z0-9]{1,20}$/.test(m) ? m : null);
  const gifDim = (n) => { const v = Math.round(+n); return v > 0 && v <= 2000 ? v : null; };
  const cleanName = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, 24) : '');
  const normCode = (c) => String(c == null ? '' : c).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const inParty = () => ['connected', 'reconnecting'].includes(status.state) || (status.state === 'hosting' && roster.length > 0);
  function list(names) {
    try { return new Intl.ListFormat('en', { type: 'conjunction' }).format(names); } catch (_) { return names.join(', '); }
  }
  // Program milliseconds -> "m:ss" or "h:mm:ss".
  function fmtMs(ms) {
    const t = Math.max(0, Math.floor((+ms || 0) / 1000));
    const s = String(t % 60).padStart(2, '0'), m = Math.floor(t / 60) % 60, hr = Math.floor(t / 3600);
    return hr ? `${hr}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  function eventMs(ev) { // v3 sends ms; tolerate the v2 seconds field
    if (typeof ev.ms === 'number' && isFinite(ev.ms)) return ev.ms;
    if (typeof ev.time === 'number' && isFinite(ev.time)) return ev.time * 1000;
    return null;
  }
  function plain(v) { // port messages must be JSON-safe
    try { return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (_) { return null; }
  }
  function stateCopy() {
    const out = {};
    for (const k in HWP.state) {
      const v = HWP.state[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
      else if (Array.isArray(v)) out[k] = plain(v);
    }
    return out;
  }
  const uiCopy = () => ({ hostName, waiting: waiting.slice(), adMe, unread, playerReady, panels: panelCount });
  function safe(fn, what) { try { return fn(); } catch (e) { HWP.log(what || 'ui call failed', e); return undefined; } }

  // ---------- port to background.js ----------
  function hasRuntime() {
    try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id && chrome.runtime.connect); } catch (_) { return false; }
  }
  function connectPort() {
    retryTimer = null;
    if (port || portDead) return;
    if (!hasRuntime()) { portDead = true; return; }
    let p;
    try { p = chrome.runtime.connect({ name: 'hwp-page' }); } catch (e) { HWP.log('connect failed', e); portDead = true; return; }
    port = p;
    p.onMessage.addListener((msg) => { retryMs = 1000; onPortMessage(msg); });
    p.onDisconnect.addListener(() => {
      try { void chrome.runtime.lastError; } catch (_) {}
      if (port !== p) return;
      port = null;
      panelCount = 0;
      if (!hasRuntime()) { portDead = true; return; } // extension reloaded or removed
      retryTimer = setTimeout(connectPort, retryMs); // service worker restarted: re-register
      retryMs = Math.min(retryMs * 2, 30000);
    });
  }
  function post(msg) {
    if (!port) return false;
    try { port.postMessage(msg); return true; } catch (e) { HWP.log('post failed', e); return false; }
  }
  const postState = () => post({ type: 'state', state: stateCopy(), status: plain(status), ui: uiCopy() });
  const snapshot = () => ({ type: 'snapshot', state: stateCopy(), status: plain(status), log: plain(log.slice(-MAX_LINES)), ui: uiCopy() });

  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'panels') { // background: how many panels are bound to this tab
      panelCount = Math.max(0, +msg.count || 0);
      return;
    }
    command(msg);
  }

  // Panel commands. Also exposed as HWP.ui.command for tests (no chrome.runtime on a test page).
  function command(cmd) {
    if (!cmd || typeof cmd !== 'object') return false;
    switch (cmd.type) {
      case 'hello':
        unread = 0;
        post(snapshot());
        return true;
      case 'set-name':
        setName(cmd.name); postState();
        return true;
      case 'host': {
        if (cmd.name != null) setName(cmd.name);
        const code = normCode(cmd.code).length === 4 ? normCode(cmd.code) : randomCode();
        callNet(() => HWP.net.host(code));
        return true;
      }
      case 'join': {
        if (cmd.name != null) setName(cmd.name);
        const code = normCode(cmd.code);
        if (code.length !== 4) { postState(); return false; }
        callNet(() => HWP.net.join(code));
        return true;
      }
      case 'leave':
        safe(() => HWP.net.leave(), 'leave failed');
        if (status.state !== 'idle') onStatus({ state: 'idle', peerCount: 0 }); // in case net didn't emit it
        else postState();
        return true;
      case 'chat': {
        const text = typeof cmd.text === 'string' ? cmd.text.trim().slice(0, 500) : '';
        if (!text) return false;
        const mid = newMid();
        safe(() => HWP.net.send({ type: 'chat', text, mid }), 'send failed');
        addChat('You', text, true, mid);
        return true;
      }
      case 'gif': {
        const url = gifUrl(cmd.url);
        if (!url) return false;
        const w = gifDim(cmd.w), hgt = gifDim(cmd.h);
        const mid = newMid();
        safe(() => HWP.net.send({ type: 'gif', url, w, h: hgt, mid }), 'send failed');
        addGif('You', url, w, hgt, true, mid);
        return true;
      }
      case 'msg-react': { // toggle my emoji on one message
        const mid = cleanMid(cmd.mid);
        if (!mid || !EMOJIS.includes(cmd.emoji)) return false;
        const on = toggleReact(mid, cmd.emoji, 'You');
        if (on == null) return false;
        safe(() => HWP.net.send({ type: 'msg-react', mid, emoji: cmd.emoji, on }), 'send failed');
        return true;
      }
      case 'reaction':
        if (!EMOJIS.includes(cmd.emoji)) return false;
        return react(cmd.emoji);
      case 'control': {
        const mode = cmd.mode;
        if ((mode !== 'everyone' && mode !== 'host') || HWP.state.role !== 'host') { postState(); return false; }
        if (HWP.state.controlMode === mode) { postState(); return true; }
        HWP.state.controlMode = mode;
        safe(() => HWP.net.send({ type: 'control', mode }), 'send failed');
        sys(mode === 'host' ? 'Only you can play, pause or skip now' : 'Anyone can play, pause or skip now');
        postState();
        return true;
      }
      default:
        return false;
    }
  }

  // net.js normally answers host/join with a net:status at once; if it throws, say so instead of hanging.
  function callNet(fn) {
    try { fn(); } catch (e) {
      HWP.log('net call failed', e);
      onStatus({ state: 'error', message: 'Something went wrong. Try again.', peerCount: 0 });
      return;
    }
    postState();
  }

  function setName(n) {
    const name = cleanName(n);
    if (!name) return;
    HWP.state.name = name;
    store.set('hwp-name', name);
  }
  function randomCode() {
    const rnd = crypto.getRandomValues(new Uint32Array(4));
    return [...rnd].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
  }
  function react(emoji) {
    if (Date.now() - lastReactAt < 250) return false; // light spam guard
    lastReactAt = Date.now();
    safe(() => HWP.net.send({ type: 'reaction', emoji }), 'send failed');
    floatEmoji(emoji, 'You');
    return true;
  }

  // ---------- chat log ----------
  function record(line) {
    log.push(line);
    if (log.length > MAX_LINES) log.splice(0, log.length - MAX_LINES);
    post({ type: 'line', line });
    saveLog();
  }
  function addChat(who, text, mine, mid) {
    record({ id: nextId++, kind: 'chat', at: Date.now(), who, text, mine: !!mine, mid: cleanMid(mid) });
  }
  function addGif(who, url, w, hgt, mine, mid) {
    record({ id: nextId++, kind: 'gif', at: Date.now(), who, url, w, h: hgt, mine: !!mine, mid: cleanMid(mid) });
  }
  // Reactions live on the line as { emoji: [names] }. Returns the new on/off state, or null if no such
  // line (an old message that scrolled out, or one from before this person joined).
  function toggleReact(mid, emoji, who, force) {
    const line = log.find((l) => l.mid === mid && (l.kind === 'chat' || l.kind === 'gif'));
    if (!line) return null;
    const r = line.reacts || (line.reacts = {});
    const names = r[emoji] || [];
    const has = names.includes(who);
    const on = force == null ? !has : !!force;
    if (on === has) return on;
    if (on) names.push(who); else names.splice(names.indexOf(who), 1);
    if (names.length) r[emoji] = names; else delete r[emoji];
    if (!Object.keys(r).length) delete line.reacts;
    post({ type: 'line', line });
    saveLog();
    return on;
  }
  // Muted system line. `merge` collapses a burst (scrubbing = many seeks) into one updating line:
  // the panel replaces the line with the same id.
  function sys(text, merge) {
    const now = Date.now(), last = log[log.length - 1];
    if (merge && last && last.merge === merge && now - last.at < 4000) {
      last.text = text; last.at = now;
      post({ type: 'line', line: last });
      saveLog();
      return;
    }
    const line = { id: nextId++, kind: 'sys', at: now, text };
    if (merge) line.merge = merge;
    record(line);
  }
  function saveLog() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (HWP.state.code && log.length) sess.set(LOG_KEY, { code: HWP.state.code, nextId, log });
      else sess.del(LOG_KEY);
    }, 400);
  }
  // A reload mid-party (follow-host navigation, manual refresh) keeps the conversation.
  function restoreLog() {
    const saved = sess.get(LOG_KEY);
    const s = HWP.session && HWP.session.load ? safe(() => HWP.session.load()) : null;
    if (saved && s && s.code && saved.code === s.code && Array.isArray(saved.log)) {
      log = saved.log.filter((l) => l && typeof l === 'object' && typeof l.id === 'number').slice(-MAX_LINES);
      nextId = Math.max(+saved.nextId || 1, ...log.map((l) => l.id + 1), 1);
    } else sess.del(LOG_KEY);
  }
  function bumpUnread() {
    if (panelCount > 0) return;
    unread++;
    HWP.bus.emit('ui:unread', { count: unread });
  }

  function onFullscreen() { if (floats) floatLayer(); }

  // ---------- reactions over the video ----------
  // Lives in <body>, or inside the fullscreen element so it still shows in fullscreen.
  function floatLayer() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.body || document.documentElement;
    if (!floats) floats = h('div', { id: 'hwp-floats', 'aria-hidden': 'true' });
    if (floats.parentNode !== parent) parent.appendChild(floats);
    return floats;
  }
  function floatEmoji(emoji, who) {
    const layer = floatLayer();
    if (layer.childElementCount >= 24) return; // never bury the movie
    const f = h('div', { className: 'hwp-float' },
      h('span', { className: 'hwp-float-emoji', text: emoji }), who && h('span', { className: 'hwp-float-name', text: who }));
    f.style.left = Math.round(window.innerWidth * (0.1 + Math.random() * 0.75)) + 'px';
    const done = () => f.remove();
    f.addEventListener('animationend', done);
    setTimeout(done, 2000); // fallback if animations never run
    layer.appendChild(f);
  }

  // ---------- bus handlers ----------
  function resetParty() {
    roster = [];
    rosterPrimed = false;
    hostName = '';
    waiting = [];
    HWP.state.controlMode = 'everyone';
    log = [];
    sess.del(LOG_KEY);
    unread = 0;
    post(snapshot()); // the panel clears its chat from this
  }

  function onStatus(st) {
    if (!st || !st.state) return;
    const prev = status.state;
    status = Object.assign({}, st);
    if (st.state === 'idle' && prev !== 'idle') resetParty();
    if (st.state === 'hosting') rosterPrimed = true; // host starts alone: every roster change is news
    if (st.state === 'joining' && prev !== 'joining') rosterPrimed = false;
    if (st.state === 'reconnecting' && prev !== 'reconnecting') sys('Lost the connection, reconnecting…');
    if (st.state === 'connected' && prev === 'reconnecting') sys('Back in the party');
    postState();
  }

  // Multiset difference so two people both named "Alex" are tracked correctly.
  function minus(a, b) {
    const rest = b.slice();
    return a.filter((x) => { const i = rest.indexOf(x); if (i < 0) return true; rest.splice(i, 1); return false; });
  }
  function onRoster(r) {
    const next = (r && Array.isArray(r.names) ? r.names : []).map(cleanName).map((n) => n || 'Someone');
    if (!rosterPrimed) {
      if (next.length) { sys("You're in! Watching with " + list(next) + '.'); rosterPrimed = true; }
    } else {
      for (const n of minus(next, roster)) sys(n + ' joined');
      for (const n of minus(roster, next)) sys(n + ' left');
    }
    roster = next;
    postState();
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const who = cleanName(msg.from) || 'Someone';
    if (msg.type === 'chat' && typeof msg.text === 'string' && msg.text.trim()) {
      addChat(who, msg.text.trim().slice(0, 500), false, msg.mid);
      bumpUnread();
    } else if (msg.type === 'gif' && gifUrl(msg.url)) {
      addGif(who, gifUrl(msg.url), gifDim(msg.w), gifDim(msg.h), false, msg.mid);
      bumpUnread();
    } else if (msg.type === 'msg-react' && cleanMid(msg.mid) && EMOJIS.includes(msg.emoji)) {
      toggleReact(cleanMid(msg.mid), msg.emoji, who, !!msg.on);
    } else if (msg.type === 'reaction' && EMOJIS.includes(msg.emoji)) { // whitelist: no arbitrary text floats
      floatEmoji(msg.emoji, who);
      bumpUnread();
    } else if (msg.type === 'control' && HWP.state.role !== 'host' && (msg.mode === 'everyone' || msg.mode === 'host')) {
      // net.js has usually applied the mode already, so don't compare; the host only sends on a change.
      HWP.state.controlMode = msg.mode;
      sys(msg.mode === 'host'
        ? who + ' turned off shared controls. Only the host can play, pause or skip.'
        : who + ' turned on shared controls. Anyone can play, pause or skip.');
      postState();
    } else if (msg.type === 'welcome') {
      hostName = who;
      if (msg.controlMode === 'everyone' || msg.controlMode === 'host') HWP.state.controlMode = msg.controlMode;
      postState();
    } else if (msg.type === 'end' && HWP.state.role !== 'host') {
      sys(who + ' ended the party.');
    }
  }

  function onSyncEvent(ev) {
    if (!ev) return;
    const who = cleanName(ev.by) || 'Someone';
    const ms = eventMs(ev);
    const at = ms == null ? '' : ' at ' + fmtMs(ms);
    if (ev.kind === 'play') sys(who + ' pressed play' + at);
    else if (ev.kind === 'pause') sys(who + ' paused' + at);
    else if (ev.kind === 'seek') sys(who + ' skipped to ' + (ms == null ? 'a new spot' : fmtMs(ms)), 'seek:' + who);
  }

  // Someone else's ad shows up as sync:waiting (the room pauses for them); only my own is a line here.
  function onAd(ev) {
    if (!ev || ev.who !== 'me') return;
    const on = !!ev.on;
    if (on === adMe) return;
    adMe = on;
    if (inParty()) sys(on ? 'An ad is playing for you. The others are paused until it ends.' : 'Your ad finished, catching up', 'ad:me');
    postState();
  }

  function onWaiting(ev) {
    const names = (ev && Array.isArray(ev.names) ? ev.names : [])
      .filter((n) => typeof n === 'string' && n !== 'me').map((n) => cleanName(n) || 'Someone');
    const was = waiting;
    waiting = names;
    if (names.join('\n') === was.join('\n')) return;
    if (names.length) sys('Waiting for ' + list(names) + "'s " + (names.length > 1 ? 'ads' : 'ad') + ' to finish…', 'wait');
    else if (was.length) sys("Everyone's back, resuming", 'wait');
    postState();
  }

  function onPlayer(ready) {
    return () => { if (playerReady !== ready) { playerReady = ready; postState(); } };
  }

  function wire() {
    // Forward raw events first so the panel sees them before the state/line they cause.
    for (const name of FWD_EVENTS) {
      HWP.bus.on(name, (payload) => post({ type: 'event', name, payload: plain(payload) }));
    }
    HWP.bus.on('net:message', (msg) => {
      if (msg && FWD_MESSAGES.has(msg.type)) post({ type: 'event', name: 'net:message', payload: plain(msg) });
    });
    HWP.bus.on('net:status', onStatus);
    HWP.bus.on('net:roster', onRoster);
    HWP.bus.on('net:message', onMessage);
    HWP.bus.on('sync:event', onSyncEvent);
    HWP.bus.on('sync:ad', onAd);
    HWP.bus.on('sync:waiting', onWaiting);
    HWP.bus.on('player:ready', onPlayer(true));
    HWP.bus.on('player:gone', onPlayer(false));
  }

  // ---------- init ----------
  function init() {
    if (inited) return;
    inited = true;
    HWP.state.name = cleanName(store.get('hwp-name')) || HWP.state.name || '';
    const st = HWP.net && HWP.net.status ? safe(() => HWP.net.status()) : null;
    if (st && st.state) status = st;
    restoreLog();
    document.addEventListener('fullscreenchange', onFullscreen);
    wire();
    connectPort();
    setInterval(() => { if (port) post({ type: 'ping' }); }, PING_MS);
  }

  HWP.ui = {
    init,
    command,                                   // same entry point the side panel uses
    snapshot: () => plain(snapshot()),
    unread: () => unread,
  };
})();
