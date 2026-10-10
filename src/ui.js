// Sidebar UI: name/host/join flow, party code, people, chat, reactions, host control toggle.
// Talks to the other modules only through HWP.net.*, HWP.bus events and HWP.state (see PLAN.md).
// User-supplied text (names, chat) is only ever written with textContent, never innerHTML.
(() => {
  const SIDEBAR_PX = 320;
  const MAX_LINES = 300;
  const EMOJIS = ['😂', '❤️', '😭', '🔥', '👀', '🍿'];
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I lookalikes
  const LAYOUT_CSS = `
    html, body, #root, #dplus-app-element, [class*="video_view"], [class*="hudson-contain"],
    [class*="player-container-root"], .mini-player-bounds, draggable-surface, .mini-player-inner,
    .btm-media-player, .btm-media-clients, .media-element-container, video.hive-video {
      width: calc(100vw - ${SIDEBAR_PX}px) !important;
      max-width: calc(100vw - ${SIDEBAR_PX}px) !important;
    }`;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  const el = {};               // persistent nodes, re-mounted into .hwp-body per view
  let panel, body, layoutStyle, floats;
  let view = { state: 'idle' }; // last status rendered
  let roster = [];             // names of the others in the room (net:roster)
  let rosterPrimed = false;    // guests: the first roster is "who's here", not a stream of "X joined"
  let hostName = '';           // learned from the host's welcome message
  let unread = 0;
  let pinned = true;           // chat follows new lines unless the user scrolled up
  let layoutOpen = null;       // is the page currently narrowed for the sidebar
  let lastReactAt = 0;

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
  const cleanName = (n) => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, 24) : '');
  const isHost = () => HWP.state.role === 'host' || view.state === 'hosting';
  const isOpen = () => !panel.classList.contains('hwp-collapsed');
  function clock(ts) {
    const d = new Date(ts);
    return (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmt(t) {
    try { if (HWP.sync && HWP.sync.fmt) return HWP.sync.fmt(t); } catch (_) {}
    t = Math.max(0, Math.floor(+t || 0));
    const s = String(t % 60).padStart(2, '0'), m = Math.floor(t / 60) % 60, hr = Math.floor(t / 3600);
    return hr ? `${hr}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }
  function list(names) {
    try { return new Intl.ListFormat('en', { type: 'conjunction' }).format(names); } catch (_) { return names.join(', '); }
  }
  function safeSend(msg) { try { HWP.net.send(msg); } catch (e) { HWP.log('send failed', e); } }

  // ---------- build ----------
  function build() {
    el.badge = h('span', { className: 'hwp-badge', hidden: true });
    el.min = h('span', { className: 'hwp-min', text: 'Hide' });
    el.head = h('div', { className: 'hwp-head', tabIndex: 0, role: 'button', 'aria-expanded': 'true' },
      h('span', { className: 'hwp-dot' }), h('span', { className: 'hwp-title', text: 'Watch Party' }), el.badge, el.min);

    el.name = h('input', { id: 'hwp-name', type: 'text', maxLength: 24, placeholder: 'What should we call you?',
      autocomplete: 'off', spellcheck: false, value: cleanName(store.get('hwp-name')) });
    el.nameRow = h('label', { className: 'hwp-field' }, h('span', { className: 'hwp-label', text: 'Your name' }), el.name);
    el.host = h('button', { id: 'hwp-host', className: 'hwp-btn', type: 'button', text: 'Start a party' });
    el.or = h('div', { className: 'hwp-or', text: 'or join one' });
    // maxLength is loose so a pasted " ab-12 " survives; the input handler trims it to 4 clean chars.
    el.code = h('input', { id: 'hwp-code', className: 'hwp-codein', type: 'text', maxLength: 12, placeholder: 'CODE',
      autocomplete: 'off', spellcheck: false });
    el.join = h('button', { id: 'hwp-join', className: 'hwp-btn hwp-secondary', type: 'button', text: 'Join' });
    el.joinRow = h('div', { className: 'hwp-row' }, el.code, el.join);

    el.status = h('div', { className: 'hwp-status', role: 'status' });
    el.leave = h('button', { id: 'hwp-leave', className: 'hwp-btn hwp-secondary', type: 'button', text: 'Leave' });
    el.top = h('div', { className: 'hwp-top' });

    el.codeText = h('div', { className: 'hwp-code' });
    el.copy = h('button', { id: 'hwp-copy', className: 'hwp-btn hwp-secondary hwp-small', type: 'button', text: 'Copy' });
    el.codeBox = h('div', { className: 'hwp-codebox' }, h('div', { className: 'hwp-label', text: 'Party code' }),
      el.codeText, h('div', { className: 'hwp-hint', text: "Send it to whoever you're watching with" }), el.copy);

    el.people = h('div', { id: 'hwp-people', className: 'hwp-people' });
    el.note = h('div', { className: 'hwp-note' });
    el.control = h('input', { id: 'hwp-control', type: 'checkbox', checked: true });
    el.controlRow = h('label', { className: 'hwp-toggle' }, el.control, h('span', { text: 'Anyone can control' }));

    el.chat = h('div', { id: 'hwp-chat', className: 'hwp-chat', role: 'log', 'aria-live': 'polite' });
    el.reactions = h('div', { id: 'hwp-reactions', className: 'hwp-reactions' },
      ...EMOJIS.map((e) => h('button', { className: 'hwp-react', type: 'button', title: 'Send ' + e, 'data-emoji': e, text: e })));
    el.msg = h('input', { id: 'hwp-msg', className: 'hwp-msg', type: 'text', maxLength: 500, placeholder: 'Say something…',
      autocomplete: 'off' });

    body = h('div', { className: 'hwp-body' });
    panel = h('div', { id: 'hwp-panel', role: 'complementary', 'aria-label': 'Watch Party' }, el.head, body);
    document.documentElement.appendChild(panel);
    layoutStyle = h('style', { id: 'hwp-layout', text: LAYOUT_CSS });
  }

  // Keys typed in the panel must never reach the Disney+ player (Space = pause, arrows = seek).
  function isolate(node) {
    for (const t of ['keydown', 'keyup', 'keypress']) {
      node.addEventListener(t, (e) => {
        e.stopPropagation();
        if (t === 'keydown' && e.key === 'Escape' && e.target.tagName === 'INPUT') e.target.blur();
      });
    }
  }

  function wire() {
    [el.name, el.code, el.msg, el.control, panel].forEach(isolate);
    el.head.addEventListener('click', () => setOpen(!isOpen()));
    el.head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!isOpen()); }
    });
    el.host.addEventListener('click', startHost);
    el.join.addEventListener('click', startJoin);
    el.code.addEventListener('input', () => { el.code.value = el.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
    el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) startJoin(); });
    el.copy.addEventListener('click', copyCode);
    el.leave.addEventListener('click', leave);
    el.control.addEventListener('change', () => {
      const mode = el.control.checked ? 'everyone' : 'host';
      HWP.state.controlMode = mode;
      safeSend({ type: 'control', mode });
      sys(mode === 'host' ? 'Only you can play, pause or skip now' : 'Anyone can play, pause or skip now');
    });
    el.reactions.addEventListener('click', (e) => {
      const b = e.target.closest('[data-emoji]');
      if (b && !b.disabled) react(b.getAttribute('data-emoji'));
    });
    el.msg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = el.msg.value.trim().slice(0, 500);
      if (!text) return;
      el.msg.value = '';
      safeSend({ type: 'chat', text });
      addChat('You', text, true);
      pinned = true;
      scrollChat();
    });
    el.chat.addEventListener('scroll', () => {
      pinned = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight <= 40;
    });
    document.addEventListener('fullscreenchange', () => { applyLayout(); if (floats) floatLayer(); });

    HWP.bus.on('net:status', onStatus);
    HWP.bus.on('net:roster', onRoster);
    HWP.bus.on('net:message', onMessage);
    HWP.bus.on('sync:event', onSyncEvent);
    HWP.bus.on('sync:ad', onAd);
  }

  // ---------- open / collapse + page layout ----------
  function setOpen(open) {
    panel.classList.toggle('hwp-collapsed', !open);
    el.head.setAttribute('aria-expanded', String(open));
    store.set('hwp-collapsed', open ? '0' : '1');
    if (open) { unread = 0; updateBadge(); if (pinned) scrollChat(); }
    applyLayout();
  }

  // Narrow the Disney+ page so the player sits beside the sidebar, never under it.
  function applyLayout() {
    const open = isOpen() && !document.fullscreenElement;
    if (open && !layoutStyle.isConnected) document.documentElement.appendChild(layoutStyle);
    if (!open && layoutStyle.isConnected) layoutStyle.remove();
    if (open === layoutOpen) return;
    layoutOpen = open;
    window.dispatchEvent(new Event('resize')); // the player measures itself on resize
    HWP.bus.emit('ui:layout', { open });
  }

  function updateBadge() {
    el.badge.hidden = !unread;
    el.badge.textContent = unread > 99 ? '99+' : String(unread);
  }
  function bumpUnread() { if (!isOpen()) { unread++; updateBadge(); } }

  // ---------- views ----------
  function setStatus(text, cls) {
    el.status.textContent = text;
    el.status.className = 'hwp-status' + (cls ? ' ' + cls : '');
  }

  // Swap the body's children only when the view's node list actually changes, so a status
  // update (someone joined) doesn't blur the chat box mid-sentence.
  function mount(nodes) {
    const cur = [...body.children];
    if (cur.length === nodes.length && cur.every((n, i) => n === nodes[i])) return;
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    body.replaceChildren(...nodes);
    if (focused && focused.isConnected) focused.focus({ preventScroll: true });
    if (pinned) scrollChat();
  }

  function render(st) {
    view = st;
    const s = st.state;
    const code = st.code || HWP.state.code || '';
    panel.dataset.state = s; // drives the header status dot
    el.codeText.textContent = code;
    el.leave.classList.toggle('hwp-small', s === 'connected' || s === 'reconnecting');
    el.codeBox.classList.toggle('hwp-compact', s !== 'hosting');
    if (s === 'starting') {
      setStatus('Starting your party…', 'hwp-wait');
      el.leave.textContent = 'Cancel';
      mount([el.status, el.leave]);
    } else if (s === 'hosting') {
      setStatus(st.message || 'Waiting for someone to join…', 'hwp-wait'); // net's text when given ("Reclaiming your party code...")
      el.leave.textContent = 'End party';
      mount([el.codeBox, el.status, el.leave]);
    } else if (s === 'joining') {
      setStatus(st.message || 'Joining ' + code + '…', 'hwp-wait');
      el.leave.textContent = 'Cancel';
      mount([el.status, el.leave]);
    } else if (s === 'connected' || s === 'reconnecting') {
      const live = s === 'connected';
      const count = (roster.length || st.peerCount || 0) + 1;
      if (live) setStatus('Connected · ' + count + ' watching', 'hwp-ok');
      else setStatus(st.message || 'Reconnecting to the party…', 'hwp-wait');
      el.leave.textContent = isHost() ? 'End party' : 'Leave';
      if (el.status.parentNode !== el.top) el.top.append(el.status, el.leave);
      el.control.checked = HWP.state.controlMode !== 'host';
      el.msg.disabled = !live;
      el.msg.placeholder = live ? 'Say something…' : 'Reconnecting…';
      for (const b of el.reactions.children) b.disabled = !live;
      renderPeople();
      mount([el.top, isHost() && el.codeBox, el.people, isHost() ? el.controlRow : el.note, el.chat, el.reactions, el.msg]
        .filter(Boolean));
    } else if (s === 'error') {
      setStatus(st.message || 'Something went wrong. Try again.', 'hwp-bad');
      el.leave.textContent = 'Back';
      mount([el.status, el.leave]);
    } else {
      setStatus('Everyone needs this extension. One person starts a party, the others join with the code.');
      mount([el.nameRow, el.host, el.or, el.joinRow, el.status]);
    }
  }

  function renderPeople() {
    let hostMarked = false;
    const chips = roster.map((n) => {
      const isTheHost = !isHost() && !hostMarked && n === hostName;
      if (isTheHost) hostMarked = true;
      return h('span', { className: 'hwp-person', title: n, text: n + (isTheHost ? ' (host)' : '') });
    });
    const me = h('span', { className: 'hwp-person hwp-you', text: 'You' + (isHost() ? ' (host)' : '') });
    el.people.replaceChildren(h('div', { className: 'hwp-label', text: 'Watching' }), h('div', { className: 'hwp-chips' }, me, ...chips));
    el.note.textContent = !isHost() && HWP.state.controlMode === 'host' ? 'Only the host can play, pause or skip.' : '';
  }

  // ---------- actions ----------
  // Name is required before host/join; saved before calling net so hello/welcome carry it.
  function takeName() {
    const name = cleanName(el.name.value);
    if (!name) { shake(el.name); el.name.focus(); return false; }
    el.name.value = name;
    store.set('hwp-name', name);
    HWP.state.name = name;
    return true;
  }
  function shake(node) {
    node.classList.remove('hwp-shake');
    void node.offsetWidth; // restart the CSS animation
    node.classList.add('hwp-shake');
    setTimeout(() => node.classList.remove('hwp-shake'), 600);
  }
  function callNet(fn) {
    try { fn(); } catch (e) {
      HWP.log('net call failed', e);
      onStatus({ state: 'error', message: 'Something went wrong. Try again.' });
    }
  }
  function startHost() {
    if (!takeName()) return;
    const rnd = crypto.getRandomValues(new Uint32Array(4));
    const code = [...rnd].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
    render({ state: 'starting' }); // instant feedback; net:status 'hosting' replaces it once the room is open
    callNet(() => HWP.net.host(code));
  }
  function startJoin() {
    if (!takeName()) return;
    const code = el.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { shake(el.code); el.code.focus(); return; }
    render({ state: 'joining', code });
    callNet(() => HWP.net.join(code));
  }
  function leave() {
    try { HWP.net.leave(); } catch (e) { HWP.log('leave failed', e); }
    if (view.state !== 'idle') onStatus({ state: 'idle' }); // in case net didn't emit it
  }
  function copyCode() {
    const code = el.codeText.textContent;
    const flash = (t) => {
      el.copy.textContent = t;
      clearTimeout(el.copy._t);
      el.copy._t = setTimeout(() => { el.copy.textContent = 'Copy'; }, 1500);
    };
    const fallback = () => { // select the code so a manual copy works even if the clipboard API is blocked
      const r = document.createRange();
      r.selectNodeContents(el.codeText);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      flash(ok ? 'Copied!' : 'Selected');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(() => flash('Copied!'), fallback);
    else fallback();
  }
  function react(emoji) {
    if (Date.now() - lastReactAt < 250) return; // light spam guard
    lastReactAt = Date.now();
    safeSend({ type: 'reaction', emoji });
    floatEmoji(emoji, 'You');
  }

  // ---------- chat log ----------
  function scrollChat() { el.chat.scrollTop = el.chat.scrollHeight; }
  function push(line) {
    if (line.parentNode !== el.chat) el.chat.appendChild(line);
    while (el.chat.childElementCount > MAX_LINES) el.chat.firstElementChild.remove();
    if (pinned) scrollChat();
  }
  // Consecutive messages from the same person within 2 min share one name/time header.
  function addChat(who, text, mine) {
    const now = Date.now(), key = mine ? 'me' : 'u:' + who;
    const last = el.chat.lastElementChild;
    let line = last && last.dataset.who === key && now - +last.dataset.at < 120000 && last.childElementCount < 20 ? last : null;
    if (!line) {
      line = h('div', { className: 'hwp-line' + (mine ? ' hwp-me' : '') },
        h('div', { className: 'hwp-meta' }, h('span', { className: 'hwp-who', text: who }), h('span', { className: 'hwp-time', text: clock(now) })));
      line.dataset.who = key;
    }
    line.dataset.at = now;
    line.appendChild(h('div', { className: 'hwp-text', text }));
    push(line);
  }
  // Muted system line. `merge` collapses a burst (scrubbing = many seeks) into one updating line.
  function sys(text, merge) {
    const now = Date.now(), last = el.chat.lastElementChild;
    if (merge && last && last.dataset.merge === merge && now - +last.dataset.at < 4000) {
      last.textContent = text;
      last.dataset.at = now;
      return;
    }
    const line = h('div', { className: 'hwp-line hwp-sys', text });
    line.dataset.at = now;
    if (merge) line.dataset.merge = merge;
    push(line);
  }

  // ---------- reactions over the video ----------
  // Lives in <body> (or the fullscreen element, so it still shows in fullscreen), not in the panel.
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
    const width = window.innerWidth - (layoutOpen ? SIDEBAR_PX : 0);
    const f = h('div', { className: 'hwp-float' },
      h('span', { className: 'hwp-float-emoji', text: emoji }), who && h('span', { className: 'hwp-float-name', text: who }));
    f.style.left = Math.round(width * (0.1 + Math.random() * 0.75)) + 'px';
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
    HWP.state.controlMode = 'everyone';
    el.chat.replaceChildren();
    pinned = true;
    unread = 0;
    updateBadge();
  }

  function onStatus(st) {
    if (!st || !st.state) return;
    const prev = view.state;
    if (st.state === 'idle' && prev !== 'idle') resetParty();
    if (st.state === 'hosting') rosterPrimed = true; // host starts alone: every roster change is news
    if (st.state === 'joining' && prev !== 'joining') rosterPrimed = false;
    if (st.state === 'reconnecting' && prev !== 'reconnecting') sys('Lost the connection, reconnecting…');
    if (st.state === 'connected' && prev === 'reconnecting') sys('Back in the party');
    render(st);
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
    render(view); // refresh people + count
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const who = cleanName(msg.from) || 'Someone';
    if (msg.type === 'chat' && typeof msg.text === 'string' && msg.text.trim()) {
      addChat(who, msg.text.trim().slice(0, 500), false);
      bumpUnread();
    } else if (msg.type === 'reaction' && EMOJIS.includes(msg.emoji)) { // whitelist: no arbitrary text floats
      floatEmoji(msg.emoji, who);
      bumpUnread();
    } else if (msg.type === 'control' && HWP.state.role !== 'host' && (msg.mode === 'everyone' || msg.mode === 'host')) {
      // net.js has usually applied the mode already, so don't compare; the host only sends on a change.
      sys(msg.mode === 'host'
        ? who + ' turned off shared controls. Only the host can play, pause or skip.'
        : who + ' turned on shared controls. Anyone can play, pause or skip.');
      HWP.state.controlMode = msg.mode;
      render(view);
    } else if (msg.type === 'welcome') {
      hostName = who;
      if (msg.controlMode === 'everyone' || msg.controlMode === 'host') HWP.state.controlMode = msg.controlMode;
      render(view);
    }
  }

  function onSyncEvent(ev) {
    if (!ev) return;
    const who = cleanName(ev.by) || 'Someone';
    const at = typeof ev.time === 'number' && isFinite(ev.time) ? ' at ' + fmt(ev.time) : '';
    if (ev.kind === 'play') sys(who + ' pressed play');
    else if (ev.kind === 'pause') sys(who + ' paused' + at);
    else if (ev.kind === 'seek') sys(who + ' skipped to ' + fmt(ev.time), 'seek:' + who);
  }

  function onAd(ev) {
    if (!ev) return;
    const me = ev.who === 'me', who = me ? '' : cleanName(ev.who) || 'Someone';
    if (ev.on) sys(me ? "An ad is playing for you. You'll catch up when it ends." : 'An ad is playing on ' + who + "'s side…");
    else sys(me ? 'Ad over, catching up' : 'Ad over for ' + who + ', catching up');
  }

  // ---------- init ----------
  function init() {
    if (document.getElementById('hwp-panel')) return;
    HWP.state.name = cleanName(store.get('hwp-name')) || HWP.state.name || '';
    build();
    wire();
    render({ state: 'idle' });
    setOpen(store.get('hwp-collapsed') !== '1');
  }

  HWP.ui = { init };
})();
