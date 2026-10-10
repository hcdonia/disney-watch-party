// Video sync: finds the real Disney+ <video>, mirrors play/pause/seek across the party,
// runs the host heartbeat (tick), compensates for network delay, sits out ad breaks,
// and follows the host to the same title. Talks to other modules only via HWP.net.send,
// HWP.bus and HWP.state (see PLAN.md).
(() => {
  const H = window.HWP;
  if (!H || H.sync) return;
  const S = H.state;

  const TICK_MS = 4000, PICK_MS = 1000, AD_MS = 500;
  const DRIFT = 1.5, PAUSE_DRIFT = 0.3, SEEK_MIN = 0.5; // seconds of disagreement we tolerate
  const EXPECT_MS = 1500;        // a play/pause we asked for should fire its event within this long
  const ATTACH_GRACE_MS = 1500;  // guests only: a freshly attached video fires autoplay/resume events nobody asked for
  const ACTION_WIN_MS = 2000;    // after a play/pause/seek, ignore host ticks that were already in flight
  const REFUSE_MS = 8000;        // a refused seek means "ad playing" for this long
  const NAV_GUARD_MS = 10000, NAV_KEY = 'hwp-nav';
  const AD_STUCK_MS = 4 * 60 * 1000; // ad UI "visible" this long = a false positive; stop trusting the DOM
  const OWN_UI = '#hwp-panel, [id^="hwp-"]';

  let cur = null, started = false, timers = [], unsubs = [];
  let graceUntil = 0, actionAt = 0, lastInput = 0;
  const expected = { play: [], pause: [] }; // timestamps of play/pause events we caused and haven't seen yet
  let selfSeek = null;            // { t, until }: the seek we caused, so its 'seeked' is not re-broadcast
  let sample = null, seekFrom = null; // last known position, to spot tiny player-internal seeks
  let adMode = false, domAdSince = 0, domAdOffUntil = 0, refusedUntil = 0, probed = false;
  let lastRemote = null;          // guest: last host sync/tick { base, paused, rate, at }
  let lastUrl = location.href, syncTimer = null, lastStatus = null, lastPeers = 0;

  const now = () => Date.now();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const okRate = (r) => (typeof r === 'number' && r >= 0.25 && r <= 4 ? r : 1);

  // ---------- Sending ----------
  function send(msg) {
    const n = H.net;
    if (!n || typeof n.send !== 'function') return;
    try {
      if (typeof n.isConnected === 'function' && !n.isConnected()) return;
      n.send(msg);
    } catch (e) { H.log('sync: send failed', e); }
  }

  function sendState(type) {
    const v = cur;
    if (!v || adMode) return; // no video = nothing true to report (time 0 would rewind everyone)
    const msg = { type, time: v.currentTime, paused: v.paused, url: location.href };
    if (type === 'sync' || type === 'tick') msg.rate = v.playbackRate || 1;
    send(msg);
  }

  // Host only. Debounced so hello + roster + sync-request bursts produce one sync.
  function sendSyncSoon() {
    if (S.role !== 'host') return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sendState('sync'), 250);
  }
  function requestSync() { if (S.role === 'guest' && !adMode) send({ type: 'sync-request' }); }

  // ---------- Touching the video quietly ----------
  // Exact bookkeeping instead of a blanket quiet window: each video change we make should produce
  // exactly one matching event, and only that one is swallowed. A person pausing 300ms after a
  // remote seek is still a real pause.
  function expect(kind) { expected[kind].push(now()); }
  function consumeExpected(kind) {
    const t = now();
    expected[kind] = expected[kind].filter((at) => t - at < EXPECT_MS);
    if (!expected[kind].length) return false;
    expected[kind].shift();
    return true;
  }
  function doPlay(v) {
    if (!v.paused) return;
    expect('play');
    const p = v.play();
    // Can be refused by autoplay policy right after a follow-the-host reload (no user gesture yet).
    if (p && p.catch) p.catch((e) => { expected.play.shift(); H.log('sync: play() blocked', e && e.name); });
  }
  function doPause(v) { if (!v.paused) { expect('pause'); v.pause(); } }

  function seekTo(v, t) {
    if (isFinite(v.duration) && v.duration > 1) t = Math.min(t, v.duration - 0.5);
    t = Math.max(0, t);
    selfSeek = { t, until: now() + 5000 };
    const wasPlaying = !v.paused, rate = v.playbackRate || 1, at = now();
    try { v.currentTime = t; } catch (_) { return; }
    // Disney+ refuses seeks during an ad (position snaps back). currentTime reads the new
    // value immediately on a normal seek, so still being >2s off after 400ms means "ad".
    setTimeout(() => {
      if (v !== cur) return;
      const expect = t + (wasPlaying && !v.paused ? ((now() - at) / 1000) * rate : 0);
      if (Math.abs(v.currentTime - expect) > 2) {
        refusedUntil = now() + REFUSE_MS;
        probed = false;
        setAdMode(true);
      }
    }, 400);
  }
  function seekIfFar(v, t, tol) { if (t != null && Math.abs(v.currentTime - t) > tol) seekTo(v, t); }

  // B2: where the sender's video is *now*. Playing => add the one-way delay (clamped 0..5s
  // because the two machines' clocks are not perfectly in agreement).
  function remoteTarget(msg) {
    const t = Number(msg.time);
    if (!isFinite(t)) return null;
    if (msg.paused !== false || typeof msg.sentAt !== 'number') return Math.max(0, t);
    return Math.max(0, t + clamp((now() - msg.sentAt) / 1000, 0, 5) * okRate(msg.rate));
  }

  // ---------- Local events -> party ----------
  function takeSample() {
    const v = cur;
    if (v && !v.seeking) sample = { t: v.currentTime, at: now(), playing: !v.paused, rate: v.playbackRate || 1 };
  }

  function onLocal(kind) {
    const t = now();
    if (!cur || !S.role || adMode) return;
    // The host's actions are the truth, so they always go out. A guest's first events after attach are
    // usually Disney+ autoplaying / resuming, which must not drag the whole party.
    // Only play/seek (autoplay, resume-where-you-left-off); a pause is never automatic. And anything
    // right after a real click/keypress is a person, so it always goes out.
    if (S.role === 'guest' && t < graceUntil && kind !== 'pause' && t - lastInput > 1000) return;
    if (S.role === 'guest' && S.controlMode === 'host') {
      requestSync(); // host is in charge: snap back to the host right away instead of on the next tick
      return;
    }
    actionAt = t;
    sendState(kind);
  }

  const handlers = {
    play() { takeSample(); if (!consumeExpected('play')) onLocal('play'); },
    pause() { takeSample(); if (!consumeExpected('pause')) onLocal('pause'); },
    seeking() {
      if (seekFrom == null && sample) {
        seekFrom = sample.t + (sample.playing ? ((now() - sample.at) / 1000) * sample.rate : 0);
      }
    },
    seeked() {
      const v = cur, from = seekFrom, mine = selfSeek && now() < selfSeek.until && Math.abs(v.currentTime - selfSeek.t) < 2;
      seekFrom = null; selfSeek = null;
      takeSample();
      if (mine) return;
      // Sub-second jumps are the player skipping buffer gaps, not a person scrubbing.
      if (from != null && Math.abs(v.currentTime - from) < 1) return;
      onLocal('seek');
    },
  };

  // ---------- Picking the real <video> (B1) ----------
  // Disney+ keeps a dummy <video class="btm-media-client-element"> (readyState 0, 0x0) next to the
  // real one (video.hive-video). Prefer visible + loaded, largest area wins; keep the current on ties.
  function pickVideo() {
    const shown = Array.from(document.querySelectorAll('video')).filter((v) => v.offsetWidth > 0 && v.offsetHeight > 0);
    const ready = shown.filter((v) => v.readyState > 0);
    let best = null, area = -1;
    for (const v of (ready.length ? ready : shown)) {
      const a = v.offsetWidth * v.offsetHeight;
      if (a > area || (a === area && v === cur)) { best = v; area = a; }
    }
    return best;
  }

  function attach(v) {
    detach();
    cur = v;
    for (const k in handlers) v.addEventListener(k, handlers[k]);
    graceUntil = now() + ATTACH_GRACE_MS;
    sample = seekFrom = selfSeek = null;
    takeSample();
    H.log('sync: attached', v.id || v.className || 'video');
    if (S.role === 'host') sendSyncSoon(); else requestSync();
  }
  function detach() {
    if (!cur) return;
    for (const k in handlers) cur.removeEventListener(k, handlers[k]);
    cur = null;
  }

  function pickLoop() {
    const v = pickVideo();
    if (v && v !== cur) attach(v); // SPA navigation swaps the element; re-attach
    else if (!v && cur && !cur.isConnected) detach();
    if (location.href !== lastUrl) { lastUrl = location.href; sendSyncSoon(); }
  }
  function tickLoop() { if (S.role === 'host' && cur && !adMode) sendState('tick'); }

  // ---------- Ad guard (B3) ----------
  // Case-sensitive "Ad" so "AD" (audio description) and "Ad-free" don't count.
  const AD_TEXT = [/^Ad(?=$|[\s·•|:(\d])/, /\bAd \d+ of \d+\b/i, /\bAdvertisement\b/i];
  const AD_ATTR_SEL = '[class*="ad"],[class*="Ad"],[data-testid*="ad"],[data-testid*="Ad"]';
  // Whole "ad" word inside a class/testid token: ad-badge, overlay__ad, isAdPlaying, AdOverlay.
  // Not head-, load-, pad-, badge, gradient, add-button.
  const AD_TOKEN = /(^|[-_])ad([-_]|$)|(^|[-_a-z])Ad([-_A-Z]|$)|^ad[A-Z]/;

  function shown(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el, i = 0; e && i < 12; e = e.parentElement, i++) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    }
    return true;
  }

  function attrAd() {
    for (const el of document.querySelectorAll(AD_ATTR_SEL)) {
      const names = ((el.getAttribute('class') || '') + ' ' + (el.getAttribute('data-testid') || '')).split(/\s+/);
      if (!names.some((c) => AD_TOKEN.test(c) && !/ad-?free/i.test(c))) continue;
      // Require text: an always-present, empty ad wrapper must not put us in ad mode forever.
      if (!(el.textContent || '').trim() || el.closest(OWN_UI) || !shown(el)) continue;
      return true;
    }
    return false;
  }

  function textAd() {
    if (!document.body) return false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let n;
    while ((n = w.nextNode())) {
      if (!/ad/i.test(n.data)) continue; // cheap skip for the vast majority of text nodes
      const el = n.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const tx = (el.textContent || '').trim();
      if (!tx || tx.length >= 40 || !AD_TEXT.some((re) => re.test(tx))) continue;
      if (el.closest(OWN_UI) || !shown(el)) continue;
      return true;
    }
    return false;
  }

  function detectAd() {
    const v = cur, t = now();
    if (!v || !S.role) return false;
    let dom = t >= domAdOffUntil && (attrAd() || textAd());
    // Ad UI over a PAUSED video is a pause-screen ad, not an ad break: don't start ad mode for it
    // (the party can still resume us), but don't end a real break just because someone paused mid-ad.
    if (dom && v.paused && !adMode) dom = false;
    if (!dom) domAdSince = 0;
    else if (!domAdSince) domAdSince = t;
    else if (t - domAdSince > AD_STUCK_MS) {
      H.log('sync: ad UI stuck on for 4 min, treating it as a false positive for 10 min');
      domAdOffUntil = t + 10 * 60 * 1000;
      domAdSince = 0;
      dom = false;
    }
    return dom || t < refusedUntil;
  }

  // Guest's best guess of the host's position right now, from the last sync/tick.
  function hostNow() {
    const r = lastRemote;
    if (!r || now() - r.at > 15000) return null;
    return r.paused ? r.base : r.base + ((now() - r.at) / 1000) * r.rate;
  }

  function adLoop() {
    takeSample();
    const t = now();
    // Refused-seek window over: probe once with a quiet seek before declaring the ad finished.
    // Still refused => seekTo re-arms the 8s window, so ad mode does not flap on/off every 8s.
    if (refusedUntil && t >= refusedUntil) {
      const target = S.role === 'guest' ? hostNow() : null;
      if (!probed && cur && target != null && Math.abs(cur.currentTime - target) > DRIFT) {
        probed = true;
        refusedUntil = t + 700;
        seekTo(cur, target);
      } else {
        refusedUntil = 0;
        probed = false;
      }
    }
    setAdMode(detectAd());
  }

  function setAdMode(on) {
    if (on === adMode) return;
    adMode = on;
    S.adMode = on;
    H.log('sync: ad mode', on);
    H.bus.emit('sync:ad', { on, who: 'me' });
    send({ type: 'ad', on });
    if (!on) { if (S.role === 'host') sendSyncSoon(); else requestSync(); }
  }

  // ---------- Follow the host to the same title (B5) ----------
  function titleId(path) { const m = /\/(?:play|video)\/([^/?#]+)/.exec(path || ''); return m ? m[1] : null; }

  function followHost(url) {
    if (typeof url !== 'string') return false;
    let u;
    try { u = new URL(url, location.href); } catch (_) { return false; }
    const want = titleId(u.pathname);
    // Host browsing, or same title (compare ids so a /video/X -> /play/X redirect can't loop us).
    if (!want || want === titleId(location.pathname)) return false;
    // Guard lives in sessionStorage because the navigation reloads this script.
    let last = null;
    try { last = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null'); } catch (_) {}
    if (last && now() - last.at < NAV_GUARD_MS) return false;
    // Only the path travels; we stay on our own origin (keeps sessionStorage, no open redirect).
    const dest = location.origin + u.pathname + u.search;
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify({ at: now(), url: dest })); } catch (_) {}
    if (H.session) H.session.save();
    H.log('sync: following host to', dest);
    location.href = dest; // full reload; main.js session restore rejoins the party
    return true;
  }

  // ---------- Remote messages -> local video ----------
  function applyHost(msg) {
    if (S.role !== 'guest') return; // the host is the clock; it never obeys ticks
    const base = remoteTarget(msg);
    if (base == null) return;
    const paused = !!msg.paused, rate = okRate(msg.rate);
    lastRemote = { base, paused, rate, at: now() };
    if (followHost(msg.url)) return;
    const v = cur;
    if (!v || adMode || now() - actionAt < ACTION_WIN_MS) return;
    if (Math.abs((v.playbackRate || 1) - rate) > 0.01) v.playbackRate = rate;
    if (paused) { doPause(v); seekIfFar(v, base, PAUSE_DRIFT); }
    else { seekIfFar(v, base, DRIFT); doPlay(v); }
  }

  function applyAction(msg) {
    const v = cur;
    if (!v || adMode) return;
    if (S.role === 'host' && S.controlMode === 'host') return; // guests may not drive in host mode
    const target = remoteTarget(msg);
    if (target == null) return;
    actionAt = now();
    if (msg.type === 'play') { seekIfFar(v, target, DRIFT); doPlay(v); }
    else if (msg.type === 'pause') { doPause(v); seekIfFar(v, target, PAUSE_DRIFT); }
    else {
      seekIfFar(v, target, SEEK_MIN); // tiny threshold also kills any seek echo ping-pong
      if (msg.paused) doPause(v); else doPlay(v);
    }
    H.bus.emit('sync:event', { kind: msg.type, by: msg.from || 'Someone', time: Number(msg.time) || 0 });
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'play': case 'pause': case 'seek': return applyAction(msg);
      case 'sync': case 'tick': return applyHost(msg);
      case 'sync-request': return sendSyncSoon(); // no-op unless we are the host
      case 'hello': return sendSyncSoon();        // a guest just (re)joined
      case 'ad': H.bus.emit('sync:ad', { on: !!msg.on, who: msg.from || 'Someone' }); return;
      default:
    }
  }

  function onStatus(s) {
    if (!s) return;
    const peers = Number(s.peerCount) || 0;
    if (S.role === 'host' && peers > lastPeers) sendSyncSoon();
    if (S.role === 'guest' && s.state === 'connected' && lastStatus !== 'connected') requestSync();
    lastStatus = s.state;
    lastPeers = peers;
  }

  // ---------- Public API ----------
  const noteInput = () => { lastInput = now(); };
  function start() {
    if (started) return;
    started = true;
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, noteInput, true);
    unsubs = [H.bus.on('net:message', onMessage), H.bus.on('net:status', onStatus)];
    timers = [setInterval(pickLoop, PICK_MS), setInterval(adLoop, AD_MS), setInterval(tickLoop, TICK_MS)];
    pickLoop();
  }

  function stop() {
    if (!started) return;
    started = false;
    unsubs.forEach((off) => off());
    timers.forEach(clearInterval);
    for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, noteInput, true);
    unsubs = []; timers = [];
    clearTimeout(syncTimer);
    detach();
    setAdMode(false);
  }

  // 62 -> "1:02", 3753 -> "1:02:33"
  function fmt(seconds) {
    const s = Math.max(0, Math.floor(isFinite(Number(seconds)) ? Number(seconds) : 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  H.sync = { start, stop, video: () => cur, fmt };
})();
