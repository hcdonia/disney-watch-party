// Watch Party side panel: the whole party UI (name, start/join, code, people, control toggle,
// chat, reactions, leave). It holds no party state of its own: it mirrors what the Disney+ tab's
// content script (src/ui.js) sends through background.js, and sends commands back.
//
// Port protocol (name 'hwp-panel'):
//   out: {type:'bind', tabId}, {type:'hello'}, {type:'ping'},
//        {type:'set-name', name}, {type:'host', name}, {type:'join', name, code}, {type:'leave'},
//        {type:'chat', text}, {type:'reaction', emoji}, {type:'control', mode}
//   in:  {type:'page-ready'|'no-page', tabId} (background), {type:'snapshot', state, status, log, ui},
//        {type:'state', state, status, ui}, {type:'line', line}, {type:'event', name, payload}
// User-supplied text (names, chat) is only ever written with textContent.
(() => {
  const EMOJIS = ['😂', '❤️', '😭', '🔥', '👀', '🍿'];
  const MAX_LINES = 300;
  const PING_MS = 20000;
  const NO_PAGE_GRACE_MS = 1500; // a reload of the bound tab drops its port for a moment
  const DISNEY_URL = 'https://www.disneyplus.com/';

  const panel = document.getElementById('hwp-panel');
  const body = panel.querySelector('.hwp-body');
  const el = {};

  let port = null, tabId = null, windowId = null;
  let page = 'loading';            // 'loading' | 'ready' | 'none'
  let noPageTimer = null;
  let model = { state: {}, status: { state: 'idle' }, ui: {} };
  let pending = null;              // optimistic view after a click, until the page answers
  let pinned = true;               // chat follows new lines unless the user scrolled up
  let nameDirty = false;           // the user has typed in the name box: don't overwrite it

  // ---------- helpers ----------
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
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  function clock(ts) {
    const d = new Date(ts);
    return (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function list(names) {
    try { return new Intl.ListFormat('en', { type: 'conjunction' }).format(names); } catch (_) { return names.join(', '); }
  }
  const viewState = () => (pending && model.status.state === 'idle' ? pending : model.status);
  const isHost = () => model.state.role === 'host' || viewState().state === 'hosting';

  // ---------- port ----------
  function post(msg) {
    if (!port) return false;
    try { port.postMessage(msg); return true; } catch (_) { return false; }
  }
  function connect() {
    let p;
    try { p = chrome.runtime.connect({ name: 'hwp-panel' }); } catch (_) { setTimeout(connect, 1000); return; }
    port = p;
    p.onMessage.addListener(onPortMessage);
    p.onDisconnect.addListener(() => {
      try { void chrome.runtime.lastError; } catch (_) {}
      if (port !== p) return;
      port = null;
      setTimeout(connect, 300); // the service worker restarted: reconnect and re-bind
    });
    bindActiveTab();
  }
  async function bindActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) { tabId = tab.id; windowId = tab.windowId; }
    } catch (_) {}
    post({ type: 'bind', tabId });
  }
  function rebind(t) {
    tabId = t;
    clearTimeout(noPageTimer);
    page = 'loading';
    pending = null;
    render();
    post({ type: 'bind', tabId });
  }

  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'page-ready':
        clearTimeout(noPageTimer);
        post({ type: 'hello' }); // the page answers with a snapshot
        return;
      case 'no-page':
        if (page === 'ready') { // likely a reload: give the new page a moment to reconnect
          clearTimeout(noPageTimer);
          noPageTimer = setTimeout(() => { page = 'none'; render(); }, NO_PAGE_GRACE_MS);
        } else { page = 'none'; render(); }
        return;
      case 'snapshot':
        clearTimeout(noPageTimer);
        page = 'ready';
        pending = null;
        take(msg);
        renderLog(Array.isArray(msg.log) ? msg.log : []);
        render();
        return;
      case 'state':
        pending = null;
        take(msg);
        render();
        return;
      case 'line':
        if (msg.line && typeof msg.line === 'object') addLine(msg.line);
        return;
      case 'event':
        // The page follows every state-changing event with a 'state' message; status is mirrored
        // early so the view never lags a step behind.
        if (msg.name === 'net:status' && msg.payload && msg.payload.state) { model.status = msg.payload; pending = null; render(); }
        return;
      default:
    }
  }
  function take(msg) {
    if (msg.state && typeof msg.state === 'object') model.state = msg.state;
    if (msg.status && typeof msg.status === 'object' && msg.status.state) model.status = msg.status;
    if (msg.ui && typeof msg.ui === 'object') model.ui = msg.ui;
  }

  // ---------- build ----------
  function build() {
    el.loadStatus = h('div', { className: 'hwp-status hwp-wait', text: 'Connecting to this tab…' });

    el.open = h('button', { id: 'hwp-open', className: 'hwp-btn', type: 'button', text: 'Open Disney+' });
    el.noPage = [
      h('h2', { className: 'hwp-heading', text: 'Open a Disney+ video first' }),
      h('p', { className: 'hwp-blurb', text: 'The party runs inside your Disney+ tab. Open Disney+ in this tab and pick something to watch. Already there? Reload the tab.' }),
      el.open,
    ];

    el.name = h('input', { id: 'hwp-name', type: 'text', maxLength: 24, placeholder: 'What should we call you?',
      autocomplete: 'off', spellcheck: false });
    el.nameRow = h('label', { className: 'hwp-field' }, h('span', { className: 'hwp-label', text: 'Your name' }), el.name);
    el.host = h('button', { id: 'hwp-host', className: 'hwp-btn', type: 'button', text: 'Start a party' });
    el.or = h('div', { className: 'hwp-or', text: 'or join one' });
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
    el.banner = h('div', { id: 'hwp-banner', className: 'hwp-banner', role: 'status' });

    el.chat = h('div', { id: 'hwp-chat', className: 'hwp-chat', role: 'log', 'aria-live': 'polite' });
    el.reactions = h('div', { id: 'hwp-reactions', className: 'hwp-reactions' },
      ...EMOJIS.map((e) => h('button', { className: 'hwp-react', type: 'button', title: 'Send ' + e, 'data-emoji': e, text: e })));
    el.msg = h('input', { id: 'hwp-msg', className: 'hwp-msg', type: 'text', maxLength: 500, placeholder: 'Say something…',
      autocomplete: 'off' });
  }

  function wire() {
    el.open.addEventListener('click', openDisney);
    el.name.addEventListener('input', () => { nameDirty = true; });
    el.name.addEventListener('change', () => {
      const name = cleanName(el.name.value);
      if (name) post({ type: 'set-name', name });
    });
    el.host.addEventListener('click', startHost);
    el.join.addEventListener('click', startJoin);
    el.code.addEventListener('input', () => { el.code.value = normCode(el.code.value); });
    el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) startJoin(); });
    el.copy.addEventListener('click', copyCode);
    el.leave.addEventListener('click', () => {
      pending = null;
      post({ type: 'leave' });
      render();
    });
    el.control.addEventListener('change', () => post({ type: 'control', mode: el.control.checked ? 'everyone' : 'host' }));
    el.reactions.addEventListener('click', (e) => {
      const b = e.target.closest('[data-emoji]');
      if (b && !b.disabled) post({ type: 'reaction', emoji: b.getAttribute('data-emoji') });
    });
    el.msg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = el.msg.value.trim().slice(0, 500);
      if (!text) return;
      if (!post({ type: 'chat', text })) return; // keep the text if it couldn't go out
      el.msg.value = '';
      pinned = true;
    });
    el.chat.addEventListener('scroll', () => {
      pinned = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight <= 40;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target && e.target.tagName === 'INPUT') e.target.blur();
    });
    chrome.tabs.onActivated.addListener((info) => {
      if (windowId !== null && info.windowId !== windowId) return; // another window's tab
      if (info.tabId !== tabId) rebind(info.tabId);
    });
  }

  // ---------- actions ----------
  function takeName() {
    const name = cleanName(el.name.value);
    if (!name) { shake(el.name); el.name.focus(); return null; }
    el.name.value = name;
    return name;
  }
  function shake(node) {
    node.classList.remove('hwp-shake');
    void node.offsetWidth; // restart the CSS animation
    node.classList.add('hwp-shake');
    setTimeout(() => node.classList.remove('hwp-shake'), 600);
  }
  function startHost() {
    const name = takeName();
    if (!name) return;
    if (!post({ type: 'host', name })) return;
    pending = { state: 'starting' }; // instant feedback; the page's status replaces it
    render();
  }
  function startJoin() {
    const name = takeName();
    if (!name) return;
    const code = normCode(el.code.value);
    if (code.length !== 4) { shake(el.code); el.code.focus(); return; }
    if (!post({ type: 'join', name, code })) return;
    pending = { state: 'joining', code };
    render();
  }
  function openDisney() {
    const done = () => { try { void chrome.runtime.lastError; } catch (_) {} };
    try {
      if (typeof tabId === 'number') chrome.tabs.update(tabId, { url: DISNEY_URL }, done);
      else chrome.tabs.create({ url: DISNEY_URL }, done);
    } catch (_) { window.open(DISNEY_URL, '_blank'); }
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

  // ---------- views ----------
  function setStatus(text, cls) {
    el.status.textContent = text;
    el.status.className = 'hwp-status' + (cls ? ' ' + cls : '');
  }
  // Swap the body's children only when the node list changes, so a status update
  // (someone joined) doesn't blur the chat box mid-sentence.
  function mount(nodes) {
    nodes = nodes.filter(Boolean);
    const cur = [...body.children];
    if (cur.length === nodes.length && cur.every((n, i) => n === nodes[i])) return;
    const focused = body.contains(document.activeElement) ? document.activeElement : null;
    body.replaceChildren(...nodes);
    if (focused && focused.isConnected) focused.focus({ preventScroll: true });
    if (pinned) scrollChat();
  }

  function render() {
    if (page === 'loading') { panel.dataset.state = 'loading'; mount([el.loadStatus]); return; }
    if (page === 'none') { panel.dataset.state = 'off'; mount(el.noPage); return; }
    const st = viewState();
    const s = st.state;
    const code = st.code || model.state.code || '';
    panel.dataset.state = s;
    el.codeText.textContent = code;
    el.leave.classList.toggle('hwp-small', s === 'connected' || s === 'reconnecting');
    el.codeBox.classList.toggle('hwp-compact', s !== 'hosting');
    if (s === 'starting') {
      setStatus('Starting your party…', 'hwp-wait');
      el.leave.textContent = 'Cancel';
      mount([el.status, el.leave]);
    } else if (s === 'hosting') {
      setStatus(st.message || 'Waiting for someone to join…', 'hwp-wait');
      el.leave.textContent = 'End party';
      mount([el.codeBox, el.status, el.leave]);
    } else if (s === 'joining') {
      setStatus(st.message || 'Joining ' + code + '…', 'hwp-wait');
      el.leave.textContent = 'Cancel';
      mount([el.status, el.leave]);
    } else if (s === 'connected' || s === 'reconnecting') {
      const live = s === 'connected';
      const others = Array.isArray(model.state.peerNames) ? model.state.peerNames.length : 0;
      const count = (others || st.peerCount || 0) + 1;
      if (live) setStatus('Connected · ' + count + ' watching', 'hwp-ok');
      else setStatus(st.message || 'Reconnecting to the party…', 'hwp-wait');
      el.leave.textContent = isHost() ? 'End party' : 'Leave';
      if (el.status.parentNode !== el.top) el.top.append(el.status, el.leave);
      el.control.checked = model.state.controlMode !== 'host';
      el.msg.disabled = !live;
      el.msg.placeholder = live ? 'Say something…' : 'Reconnecting…';
      for (const b of el.reactions.children) b.disabled = !live;
      renderPeople();
      const banner = bannerText();
      el.banner.textContent = banner;
      mount([el.top, isHost() && el.codeBox, el.people, isHost() ? el.controlRow : el.note, banner && el.banner,
        el.chat, el.reactions, el.msg]);
    } else if (s === 'error') {
      setStatus(st.message || 'Something went wrong. Try again.', 'hwp-bad');
      el.leave.textContent = 'Back';
      mount([el.status, el.leave]);
    } else {
      if (!nameDirty && document.activeElement !== el.name) el.name.value = cleanName(model.state.name);
      setStatus('Everyone needs this extension. One person starts a party, the others join with the code.');
      mount([el.nameRow, el.host, el.or, el.joinRow, el.status]);
    }
  }

  function bannerText() {
    const ui = model.ui || {};
    const waiting = Array.isArray(ui.waiting) ? ui.waiting.filter((n) => typeof n === 'string') : [];
    if (ui.adMe) return 'An ad is playing for you. The others are waiting.';
    if (waiting.length) return 'Waiting for ' + list(waiting) + "'s " + (waiting.length > 1 ? 'ads' : 'ad') + ' to finish…';
    return '';
  }

  function renderPeople() {
    const roster = (Array.isArray(model.state.peerNames) ? model.state.peerNames : []).map((n) => cleanName(n) || 'Someone');
    const hostName = cleanName((model.ui || {}).hostName);
    let hostMarked = false;
    const chips = roster.map((n) => {
      const isTheHost = !isHost() && !hostMarked && n === hostName;
      if (isTheHost) hostMarked = true;
      return h('span', { className: 'hwp-person', title: n, text: n + (isTheHost ? ' (host)' : '') });
    });
    const me = h('span', { className: 'hwp-person hwp-you', text: 'You' + (isHost() ? ' (host)' : '') });
    el.people.replaceChildren(h('div', { className: 'hwp-label', text: 'Watching' }), h('div', { className: 'hwp-chips' }, me, ...chips));
    el.note.textContent = !isHost() && model.state.controlMode === 'host' ? 'Only the host can play, pause or skip.' : '';
  }

  // ---------- chat ----------
  function scrollChat() { el.chat.scrollTop = el.chat.scrollHeight; }
  function renderLog(lines) {
    el.chat.replaceChildren();
    pinned = true;
    for (const l of lines.slice(-MAX_LINES)) if (l && typeof l === 'object') addLine(l, true);
    scrollChat();
  }
  // Lines carry an id: a repeat id (a merged burst of seeks, "Waiting for…") updates in place.
  // Consecutive messages from the same person within 2 min share one name/time header.
  function addLine(line, bulk) {
    const id = String(line.id);
    const text = typeof line.text === 'string' ? line.text : '';
    const existing = el.chat.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (existing) { existing.textContent = text; if (!bulk && pinned) scrollChat(); return; }
    const at = +line.at || Date.now();
    if (line.kind === 'chat') {
      const who = line.mine ? 'You' : cleanName(line.who) || 'Someone';
      const key = line.mine ? 'me' : 'u:' + who;
      const last = el.chat.lastElementChild;
      let group = last && last.dataset.who === key && at - +last.dataset.at < 120000 && last.childElementCount < 20 ? last : null;
      if (!group) {
        group = h('div', { className: 'hwp-line' + (line.mine ? ' hwp-me' : '') },
          h('div', { className: 'hwp-meta' }, h('span', { className: 'hwp-who', text: who }), h('span', { className: 'hwp-time', text: clock(at) })));
        group.dataset.who = key;
        el.chat.appendChild(group);
      }
      group.dataset.at = at;
      const t = h('div', { className: 'hwp-text', text });
      t.dataset.id = id;
      group.appendChild(t);
    } else {
      const n = h('div', { className: 'hwp-line hwp-sys', text });
      n.dataset.id = id;
      el.chat.appendChild(n);
    }
    while (el.chat.childElementCount > MAX_LINES) el.chat.firstElementChild.remove();
    if (!bulk && pinned) scrollChat();
  }

  // ---------- init ----------
  build();
  wire();
  render();
  connect();
  setInterval(() => post({ type: 'ping' }), PING_MS); // keeps the service worker (relay) alive
})();
