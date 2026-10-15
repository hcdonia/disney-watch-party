// Watch Party side panel: the whole party UI (name, start/join, code, people, control toggle,
// chat, reactions, leave). It holds no party state of its own: it mirrors what the Disney+ tab's
// content script (src/ui.js) sends through background.js, and sends commands back.
//
// Port protocol (name 'hwp-panel'):
//   out: {type:'bind', tabId}, {type:'hello'}, {type:'ping'},
//        {type:'set-name', name}, {type:'host', name}, {type:'join', name, code}, {type:'leave'},
//        {type:'chat', text}, {type:'gif', url, w, h}, {type:'msg-react', mid, emoji}, {type:'reaction', emoji},
//        {type:'control', mode}
// GIF search is KLIPY (app key in config.js). Only KLIPY image URLs are ever rendered.
//   in:  {type:'page-ready'|'no-page', tabId} (background), {type:'snapshot', state, status, log, ui},
//        {type:'state', state, status, ui}, {type:'line', line}, {type:'event', name, payload}
// User-supplied text (names, chat) is only ever written with textContent.
(() => {
  const EMOJIS = ['😂', '❤️', '😭', '🔥', '👀', '🍿'];
  const MAX_LINES = 300;
  const PING_MS = 20000;
  const NO_PAGE_GRACE_MS = 1500; // a reload of the bound tab drops its port for a moment
  const DISNEY_URL = 'https://www.disneyplus.com/';
  const KLIPY = 'https://api.klipy.com/api/v1/';
  const KLIPY_KEY = String((window.HWP_CONFIG && window.HWP_CONFIG.klipyKey) || '').replace(/[^A-Za-z0-9_-]/g, '');
  const GIF_LIMIT = 24;
  const UPDATE_URL = 'https://raw.githubusercontent.com/hcdonia/disney-watch-party/main/manifest.json';
  const UPDATE_EVERY_MS = 60 * 60 * 1000;

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
  let updateAvailable = '';        // newer version found on GitHub, or ''
  let updateDismissed = false;     // hidden for this panel session only
  let updateEl = null;
  let gifOpen = false, gifTimer = null, gifSeq = 0, gifLastQ = null;

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
  function gifUrl(u) {
    if (typeof u !== 'string' || u.length > 500) return null;
    try {
      const x = new URL(u);
      if (x.protocol !== 'https:' || !(x.hostname === 'klipy.com' || x.hostname.endsWith('.klipy.com'))) return null;
      return x.href;
    } catch (_) { return null; }
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
    el.gifBtn = h('button', { id: 'hwp-gifbtn', className: 'hwp-react hwp-gifbtn', type: 'button', title: 'Send a GIF', text: 'GIF' });
    el.reactions.appendChild(el.gifBtn);
    el.gifQ = h('input', { id: 'hwp-gifq', className: 'hwp-msg', type: 'text', maxLength: 80, placeholder: 'Search GIFs…', autocomplete: 'off' });
    el.gifGrid = h('div', { className: 'hwp-gifgrid' });
    el.gifNote = h('div', { className: 'hwp-gifnote' });
    el.gifTray = h('div', { id: 'hwp-giftray', className: 'hwp-giftray' }, el.gifQ, el.gifNote, el.gifGrid, h('div', { className: 'hwp-gifcredit', text: 'Powered by KLIPY' }));
    el.msg = h('input', { id: 'hwp-msg', className: 'hwp-msg', type: 'text', maxLength: 500, placeholder: 'Say something…',
      autocomplete: 'off' });
  }

  // ---------- GIF keyboard ----------
  function toggleGifs(open) {
    gifOpen = open == null ? !gifOpen : !!open;
    el.gifBtn.classList.toggle('hwp-on', gifOpen);
    el.gifBtn.setAttribute('aria-expanded', String(gifOpen));
    render();
    if (gifOpen) { el.gifQ.focus(); searchGifs(el.gifQ.value, true); }
  }
  function gifSearchSoon() {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(() => searchGifs(el.gifQ.value), 300);
  }
  async function searchGifs(q, force) {
    q = String(q || '').trim().slice(0, 80);
    if (!force && q === gifLastQ) return;
    gifLastQ = q;
    el.gifGrid.replaceChildren();
    if (!KLIPY_KEY) { el.gifNote.textContent = 'GIF search is not set up yet (missing KLIPY key in config.js).'; return; }
    el.gifNote.textContent = 'Loading…';
    const seq = ++gifSeq;
    const u = new URL(KLIPY + KLIPY_KEY + '/gifs/' + (q ? 'search' : 'trending'));
    u.searchParams.set('per_page', String(GIF_LIMIT));
    u.searchParams.set('content_filter', 'medium');
    u.searchParams.set('format_filter', 'gif,webp');
    if (q) u.searchParams.set('q', q);
    let results = [];
    try {
      const r = await fetch(u.toString());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const d = j && j.data;
      results = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []);
    } catch (e) {
      if (seq !== gifSeq) return;
      el.gifNote.textContent = 'Could not load GIFs (' + (e && e.message ? e.message : 'network') + '). Try again.';
      return;
    }
    if (seq !== gifSeq) return; // a newer search is on its way
    el.gifGrid.replaceChildren();
    let n = 0;
    for (const it of results) {
      // Small animated webp for the picker thumbnail; the "sm" size (about 200px wide) is what gets sent.
      const file = it && it.file && typeof it.file === 'object' ? it.file : null;
      const pick = file && ((file.xs && (file.xs.webp || file.xs.gif)) || (file.sm && (file.sm.webp || file.sm.gif)));
      const send = file && ((file.sm && (file.sm.webp || file.sm.gif)) || (file.md && (file.md.webp || file.md.gif)));
      const thumb = pick && gifUrl(pick.url), url = send && gifUrl(send.url);
      if (!thumb || !url) continue;
      const img = h('img', { className: 'hwp-gifpick', src: thumb, alt: String(it.title || 'GIF').slice(0, 100), loading: 'lazy', draggable: false });
      img.dataset.url = url; img.dataset.w = +send.width || 0; img.dataset.h = +send.height || 0;
      el.gifGrid.appendChild(img);
      n++;
    }
    el.gifNote.textContent = n ? '' : (q ? 'No GIFs for "' + q + '"' : 'Nothing to show right now');
  }
  function sendGif(img) {
    const url = gifUrl(img.dataset.url);
    if (!url) return;
    if (!post({ type: 'gif', url, w: +img.dataset.w || null, h: +img.dataset.h || null })) return;
    pinned = true;
    toggleGifs(false);
    el.msg.focus();
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
    el.gifBtn.addEventListener('click', () => { if (!el.gifBtn.disabled) toggleGifs(); });
    el.gifQ.addEventListener('input', gifSearchSoon);
    el.gifQ.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { clearTimeout(gifTimer); searchGifs(el.gifQ.value, true); }
      if (e.key === 'Escape') { e.preventDefault(); toggleGifs(false); el.msg.focus(); }
    });
    el.gifGrid.addEventListener('click', (e) => {
      const img = e.target.closest('img.hwp-gifpick');
      if (img) sendGif(img);
    });
    el.msg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const text = el.msg.value.trim().slice(0, 500);
      if (!text) return;
      if (!post({ type: 'chat', text })) return; // keep the text if it couldn't go out
      el.msg.value = '';
      pinned = true;
    });
    // Reactions on a message: the smiley opens a picker under that message; a chip toggles that emoji.
    el.chat.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-react]');
      const item = e.target.closest('[data-mid]');
      if (!item) return;
      if (chip) { post({ type: 'msg-react', mid: item.dataset.mid, emoji: chip.dataset.react }); closePickers(); return; }
      if (e.target.closest('.hwp-reactbtn')) { togglePicker(item); return; }
      if (!e.target.closest('.hwp-picker')) closePickers();
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
    if (updateAvailable && !updateDismissed) nodes.unshift(updateNotice());
    const cur = [...body.children];
    if (cur.length === nodes.length && cur.every((n, i) => n === nodes[i])) return;
    const focused = body.contains(document.activeElement) ? document.activeElement : null;
    body.replaceChildren(...nodes);
    if (focused && focused.isConnected) focused.focus({ preventScroll: true });
    if (pinned) scrollChat();
  }

  // ---------- update check ----------
  function updateNotice() {
    const local = chrome.runtime.getManifest().version;
    const text = 'Update available: v' + updateAvailable + ' (you have v' + local + '). Double-click update.command (Mac) or update.bat (Windows) in the extension folder, then press the refresh arrow on chrome://extensions.';
    if (!updateEl) {
      const msg = h('span', { className: 'hwp-update-text' });
      const x = h('button', { className: 'hwp-update-x', type: 'button', title: 'Hide', 'aria-label': 'Hide', text: '\u00d7' });
      x.addEventListener('click', () => { updateDismissed = true; render(); });
      updateEl = h('div', { className: 'hwp-update', role: 'status' }, msg, x);
    }
    updateEl.firstChild.textContent = text;
    return updateEl;
  }
  function newer(a, b) { // is dotted version a newer than b?
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0;
    }
    return false;
  }
  async function checkForUpdate() {
    try {
      const local = chrome.runtime.getManifest().version;
      let cached = null;
      try { cached = (await chrome.storage.local.get('hwp-update'))['hwp-update']; } catch (e) { /* storage unavailable */ }
      let remote;
      if (cached && typeof cached.at === 'number' && Date.now() - cached.at < UPDATE_EVERY_MS && cached.version) {
        remote = cached.version;
      } else {
        const r = await fetch(UPDATE_URL, { cache: 'no-store' });
        if (!r.ok) return;
        remote = String((await r.json()).version || '');
        if (!/^\d+(\.\d+)*$/.test(remote)) return;
        try { await chrome.storage.local.set({ 'hwp-update': { at: Date.now(), version: remote } }); } catch (e) { /* ignore */ }
      }
      if (newer(remote, local)) { updateAvailable = remote; render(); }
    } catch (e) { /* offline or blocked: stay quiet */ }
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
      if (!live && gifOpen) { gifOpen = false; el.gifBtn.classList.remove('hwp-on'); }
      renderPeople();
      const banner = bannerText();
      el.banner.textContent = banner;
      mount([el.top, isHost() && el.codeBox, el.people, isHost() ? el.controlRow : el.note, banner && el.banner,
        el.chat, gifOpen && el.gifTray, el.reactions, el.msg]);
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
  function closePickers() { for (const p of el.chat.querySelectorAll('.hwp-picker')) p.remove(); }
  function togglePicker(item) {
    const open = item.querySelector('.hwp-picker');
    closePickers();
    if (open) return;
    const pick = h('div', { className: 'hwp-picker', role: 'menu' },
      ...EMOJIS.map((e) => h('button', { className: 'hwp-pick', type: 'button', 'data-react': e, text: e, title: 'React ' + e })));
    item.appendChild(pick);
    if (pinned) scrollChat();
  }
  // Chips under a message: "😂 2", lit when I'm one of them. Hover text lists who.
  function renderReacts(item, line) {
    let row = item.querySelector('.hwp-reacts');
    const r = line.reacts && typeof line.reacts === 'object' ? line.reacts : {};
    const keys = EMOJIS.filter((e) => Array.isArray(r[e]) && r[e].length);
    if (!keys.length) { if (row) row.remove(); return; }
    if (!row) { row = h('div', { className: 'hwp-reacts' }); item.appendChild(row); }
    row.replaceChildren(...keys.map((e) => {
      const names = r[e].map((n) => cleanName(n) || 'Someone');
      const mine = names.includes('You');
      return h('button', { className: 'hwp-chipr' + (mine ? ' hwp-mine' : ''), type: 'button', 'data-react': e, title: list(names), text: e + ' ' + names.length });
    }));
  }
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
    if (existing) {
      if (existing.classList.contains('hwp-item')) renderReacts(existing, line); // chat/gif: only reactions change
      else existing.textContent = text;
      if (!bulk && pinned) scrollChat();
      return;
    }
    const at = +line.at || Date.now();
    if (line.kind === 'chat' || line.kind === 'gif') {
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
      let t;
      if (line.kind === 'gif') {
        const url = gifUrl(line.url);
        if (!url) return;
        const img = h('img', { className: 'hwp-gif', src: url, alt: 'GIF', draggable: false });
        if (+line.w > 0 && +line.h > 0) img.style.aspectRatio = (+line.w) + ' / ' + (+line.h);
        img.addEventListener('load', () => { if (pinned) scrollChat(); }, { once: true });
        t = h('div', { className: 'hwp-text hwp-gifline' }, img);
      } else t = h('div', { className: 'hwp-text', text });
      const item = h('div', { className: 'hwp-item' }, t);
      item.dataset.id = id;
      if (typeof line.mid === 'string' && /^[a-z0-9]{1,20}$/.test(line.mid)) {
        item.dataset.mid = line.mid;
        item.appendChild(h('button', { className: 'hwp-reactbtn', type: 'button', title: 'React to this', 'aria-label': 'React to this message', text: '☺' }));
      }
      renderReacts(item, line);
      group.appendChild(item);
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
  checkForUpdate();
  setInterval(() => post({ type: 'ping' }), PING_MS); // keeps the service worker (relay) alive
})();
