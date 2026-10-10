// Disney Watch Party: sync (PLAN.md v3 "Sync"). Program-ms model.
//
// Every position here is Disney+ PROGRAM time in milliseconds from HWP.player (the player's own
// timeline.info.playheadPositionMs). <video>.currentTime is NOT program time on Disney+ (it resets on
// ads and reloads, and its duration is the buffered edge), so this file never touches <video>.
//
// What it does:
// - Spots local play / pause / seek by comparing consecutive player:state samples, and sends them.
// - Applies remote play / pause / seek, with latency compensation.
// - Host heartbeat: `tick` every 4s; `sync` on request. Guests correct drift > 1500ms from it.
// - ROOM WAITS: while anyone is in an ad, everyone else pauses; when the last ad ends the host sends
//   `play {ms}` and the room resumes together. Someone in an ad ignores play/pause/seek until it ends,
//   then asks the host for a `sync`.
// - Follows the host to the same title (`url` on sync/tick).
//
// Messages (all positions are program ms): play {ms, url}, pause {ms, url}, seek {ms, playing, url},
// sync / tick {ms, playing, ad, adLeftMs, url}, ad {on, leftMs}, sync-request.
// Bus out: sync:event {kind, by, ms, time}, sync:ad {on, who, leftMs}, sync:waiting {names}.
(() => {
  const H = window.HWP;
  if (!H || H.sync) return;
  const S = H.state;

  const TICK_MS = 4000;           // host heartbeat
  const TOL_MS = 1500;            // disagreement we tolerate before seeking
  const SEEK_JUMP_MS = 3000;      // playhead moved this much more (or less) than the wall clock explains => a seek
  const OWN_FLIP_MS = 1500;       // a play/pause we issued shows up within this long...
  const OWN_FLIP_SETTLE_MS = 8000;// ...or, if the player was busy seeking/buffering, at the first settled state within this long
  const OWN_SEEK_MS = 8000;       // a seek we issued lands within this long...
  const OWN_SEEK_NEAR_MS = 2000;  // ...and within this far of where we asked
  const ACTION_WIN_MS = 2000;     // after a play/pause/seek, ignore host sync/ticks that were already in flight
  const GRACE_MS = 3000;          // guests: Disney+ autoplay / resume right after load is not a person
  const INPUT_MS = 1000;          // ...unless there was a real click / keypress this recently
  const LATENCY_MAX_MS = 5000;    // clocks differ between machines; cap the one-way delay we trust
  const AD_REFRESH_MS = 10000;    // while in an ad, re-announce it (keeps others' wait alive, updates time left)
  const AD_STALE_MS = 35000;      // a member's ad with no news for this long is forgotten (crashed tab)
  const NAV_GUARD_MS = 10000, NAV_KEY = 'hwp-nav';

  let started = false, timers = [], unsubs = [];
  // Local-event detection
  let prev = null;                // previous player sample (any status)
  let settled = null;             // last sample whose status was PLAYING or PAUSED: { playing, at }
  let graceUntil = 0, lastInput = 0, actionAt = 0;
  let syncAskedAt = 0;             // guest: when we last sent sync-request
  // Ads / room waits
  let localAd = false, adRefreshAt = 0;
  const memberAds = new Map();    // name -> { leftMs, at } for members currently in an ad (never self)
  let waiting = [];               // names the room is waiting on (excluding self)
  let waitPaused = false;         // we already paused (or decided not to) for the current wait
  let roomBusy = false;           // anyone in the room (incl. self) in an ad
  let resumeAfter = false;        // host: room was playing when it got busy => resume when it clears
  // Misc
  let syncTimer = null, lastUrl = location.href, lastPath = location.pathname, lastNetState = null, lastPeers = 0;

  const now = () => Date.now();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }; // Number(null) is 0: guard it
  const P = () => H.player || null;
  const ready = () => { const p = P(); return !!(p && p.ready()); };

  // ---------- sending ----------
  function send(msg) {
    const n = H.net;
    if (!n || typeof n.send !== 'function') return;
    try {
      if (typeof n.isConnected === 'function' && !n.isConnected()) return;
      n.send(msg);
    } catch (e) { H.log('sync: send failed', e); }
  }

  function stateMsg(type) {
    const p = P();
    if (!ready()) return null; // no player = nothing true to report (ms 0 would rewind everyone)
    const ms = p.ms();
    if (ms == null) return null;
    // Sent during our own ad too (ad: true, playhead frozen at the break) so late joiners know to wait.
    return { type, ms: Math.round(ms), playing: p.playing(), ad: localAd, adLeftMs: localAd ? p.adLeftMs() : null, url: location.href };
  }
  function sendState(type) { const m = stateMsg(type); if (m) send(m); }
  // Host only. Debounced so hello + roster + sync-request bursts produce one sync.
  function sendSyncSoon() {
    if (S.role !== 'host') return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sendState('sync'), 250);
  }
  function requestSync() { if (S.role === 'guest' && !localAd) { syncAskedAt = now(); send({ type: 'sync-request' }); } }
  function tickLoop() { if (S.role === 'host') sendState('tick'); }

  // ---------- local events -> party ----------
  // PLAYING / PAUSED are settled; SEEKING / BUFFERING / LOADING are in transition (decide later).
  function settledPlaying(s) {
    if (s.status === 'PLAYING') return true;
    if (s.status === 'PAUSED') return false;
    if (!s.status) return s.playing; // unknown player build: trust the flag
    return null;
  }

  // Did we cause this play/pause? `prevSettledAt` = when the last settled sample before this one arrived.
  function ownFlip(kind, t, prevSettledAt) {
    const p = P(), c = p && p.lastCmds[kind];
    if (!c) return false;
    const age = t - c.at;
    if (age <= OWN_FLIP_MS) return true;
    // First settled state since our command (the player went SEEKING/BUFFERING in between).
    return age <= OWN_FLIP_SETTLE_MS && prevSettledAt <= c.at + 300;
  }
  function ownSeek(ms, t) {
    const p = P(), c = p && p.lastCmds.seek;
    return !!c && t - c.at <= OWN_SEEK_MS && Math.abs(ms - c.ms) <= OWN_SEEK_NEAR_MS;
  }

  function resetBaseline() { prev = null; settled = null; }

  function detect(s, t) {
    if (s.ad || s.ms == null) return; // in an ad: the playhead is frozen and nothing a person does counts
    const sp = settledPlaying(s);
    if (!settled) {
      // First settled sample after (re)attach: just the baseline. Then line up with the room.
      if (sp == null) return;
      settled = { playing: sp, at: t };
      if (S.role === 'guest') { graceUntil = t + GRACE_MS; requestSync(); }
      else if (S.role === 'host') sendSyncSoon();
      return;
    }
    // Seek: compare with the previous sample. Expected movement only while it was really PLAYING
    // (BUFFERING / SEEKING / paused don't move the playhead). Not across an ad (prev.ad): the
    // playhead jumps when a queued seek lands after the ad, and that is handled by the ad-end sync.
    let seek = false;
    if (prev && !prev.ad && prev.ms != null) {
      const expected = prev.status === 'PLAYING' ? t - prev.at : 0;
      seek = Math.abs(s.ms - prev.ms - expected) > SEEK_JUMP_MS && !ownSeek(s.ms, t);
    }
    // Play / pause: settled state flipped.
    let flip = null;
    const prevSettledAt = settled.at;
    if (sp != null) {
      if (sp !== settled.playing) flip = sp ? 'play' : 'pause';
      settled = { playing: sp, at: t };
      if (flip && ownFlip(flip, t, prevSettledAt)) flip = null;
    }
    if (seek) local('seek', s);
    if (flip) local(flip, s);
  }

  function local(kind, s) {
    if (!S.role || localAd) return;
    const t = now();
    if (S.role === 'guest') {
      // A guest's player autoplays / resumes right after load. Not a person: ask the host instead.
      if (t < graceUntil && kind !== 'pause' && t - lastInput > INPUT_MS) { H.log('sync: ignoring startup', kind); requestSync(); return; }
      // Host is in charge: snap back to the host right away instead of on the next tick.
      if (S.controlMode === 'host') { requestSync(); return; }
    }
    actionAt = t;
    const ms = Math.round(s.ms);
    H.log('sync: local', kind, ms);
    if (kind === 'seek') send({ type: 'seek', ms, playing: settled ? settled.playing : !!s.playing, url: location.href });
    else send({ type: kind, ms, url: location.href });
  }

  function onState(s) {
    if (!s) return;
    const t = s.at || now();
    if (location.pathname !== lastPath) { lastPath = location.pathname; resetBaseline(); } // SPA title change
    if (!!s.ad !== localAd) setLocalAd(!!s.ad, s.adLeftMs);
    else if (localAd && t >= adRefreshAt) {
      adRefreshAt = t + AD_REFRESH_MS;
      send({ type: 'ad', on: true, leftMs: s.adLeftMs });
    }
    detect(s, t);
    prev = s;
    maybeWaitPause();
  }

  // ---------- ads + ROOM WAITS ----------
  function setLocalAd(on, leftMs) {
    localAd = on;
    S.adMode = on;
    adRefreshAt = now() + AD_REFRESH_MS;
    const left = on ? num(leftMs) : null;
    H.log('sync: my ad', on ? 'started' : 'ended');
    H.bus.emit('sync:ad', { on, who: 'me', leftMs: left });
    send({ type: 'ad', on, leftMs: left });
    if (!on) requestSync(); // guests only: catch up with the host
    updateRoom();
  }

  function setMemberAd(name, on, leftMs) {
    if (typeof name !== 'string' || !name) return;
    const was = memberAds.has(name);
    if (on) memberAds.set(name, { leftMs: num(leftMs), at: now() });
    else memberAds.delete(name);
    if (was !== on) H.bus.emit('sync:ad', { on, who: name, leftMs: on ? num(leftMs) : null });
    updateRoom();
  }

  function pruneAds(keepNames) {
    const t = now();
    for (const [name, a] of [...memberAds]) {
      const gone = keepNames && !keepNames.includes(name);
      if (gone || t - a.at > AD_STALE_MS) {
        memberAds.delete(name);
        H.bus.emit('sync:ad', { on: false, who: name, leftMs: null });
      }
    }
  }

  function updateRoom() {
    const names = [...memberAds.keys()];
    if (names.join('\n') !== waiting.join('\n')) {
      waiting = names;
      S.waiting = names.slice();
      H.log('sync: room waiting on', names);
      H.bus.emit('sync:waiting', { names: names.slice() });
    }
    const busy = localAd || waiting.length > 0;
    // Remember whether the room was playing before we pause anyone, so the host knows to resume it.
    if (busy && !roomBusy) resumeAfter = localAd || (ready() && P().playing());
    const cleared = roomBusy && !busy;
    roomBusy = busy;
    if (!waiting.length) waitPaused = false;
    maybeWaitPause();
    if (cleared && S.role === 'host') resumeRoom(); // guests wait for the host's play
  }

  // Someone else is in an ad and we're not: pause once (marked as ours via HWP.player.lastCmds, so it is not
  // broadcast). Runs again when our own ad ends while others are still in theirs. A person pressing play
  // during the wait wins: we don't re-pause.
  function maybeWaitPause() {
    if (!waiting.length || localAd || waitPaused || !ready()) return;
    waitPaused = true;
    const p = P();
    if (p.playing()) { H.log('sync: pausing, waiting on', waiting); p.pause(); }
  }

  // Host: the last ad in the room just ended. Everyone resumes from the host's position.
  function resumeRoom() {
    const p = P();
    if (!ready()) return;
    if (!resumeAfter && !p.playing()) return; // the room was paused before the ad: stay paused
    if (!p.playing()) p.play();
    actionAt = now();
    const ms = Math.round(p.ms());
    H.log('sync: room resumes at', ms);
    send({ type: 'play', ms, url: location.href });
  }

  // Left the party: nobody to wait for. Never touches the player (no resume on leave).
  function clearRoom() {
    roomBusy = false; resumeAfter = false; waitPaused = false;
    pruneAds([]);
    updateRoom();
  }

  // ---------- follow the host to the same title ----------
  function titleId(path) { const m = /\/(?:play|video)\/([^/?#]+)/.exec(path || ''); return m ? m[1] : null; }
  function urlTitle(url) { try { return titleId(new URL(url, location.href).pathname); } catch (_) { return null; } }
  // Unknown on either side => assume same (test pages, browse pages).
  function sameTitle(url) { const a = typeof url === 'string' ? urlTitle(url) : null, b = titleId(location.pathname); return !a || !b || a === b; }

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

  // ---------- remote messages -> local player ----------
  // One-way delay, for targets that keep moving (sender was playing).
  function latency(msg) { return typeof msg.sentAt === 'number' ? clamp(now() - msg.sentAt, 0, LATENCY_MAX_MS) : 0; }

  // Guest: host heartbeat / requested sync. Drift correction.
  function applyHost(msg) {
    if (S.role !== 'guest') return; // the host is the clock; it never obeys ticks
    setMemberAd(msg.from || 'Host', !!msg.ad, msg.adLeftMs); // the host's own ad state rides on every tick
    if (followHost(msg.url)) return;
    const p = P();
    if (!ready() || localAd || waiting.length) return; // in an ad, or the room is waiting: the host's play resumes us
    // Ticks (and syncs we asked for BEFORE the last action) may predate that action: skip them for a moment.
    // A sync we asked for after it (host-mode snap-back, ad end) is fresh: always apply.
    const asked = msg.type === 'sync' && syncAskedAt >= actionAt;
    if (!asked && now() - actionAt < ACTION_WIN_MS) return;
    const ms = num(msg.ms);
    if (ms == null) return;
    const target = Math.max(0, ms + (msg.playing && !msg.ad ? latency(msg) : 0));
    if (Math.abs(target - p.ms()) > TOL_MS) { H.log('sync: drift', Math.round(target - p.ms()), 'ms, seeking'); p.seek(target); }
    if (!!msg.playing !== p.playing()) { if (msg.playing) p.play(); else p.pause(); }
  }

  // Anyone's play / pause / seek.
  function applyAction(msg) {
    if (localAd) return;                                          // catch up via sync-request when the ad ends
    if (S.role === 'host' && S.controlMode === 'host') return;    // guests may not drive in host mode
    if (!sameTitle(msg.url)) return;                              // different show: the host's tick moves guests over
    const p = P();
    const ms = num(msg.ms);
    if (!ready() || ms == null) return;
    const kind = msg.type;
    const playAfter = kind === 'play' || (kind === 'seek' && !!msg.playing);
    const target = Math.max(0, ms + (playAfter ? latency(msg) : 0));
    // A deliberate seek is honored a bit more tightly than play/pause drift.
    const far = Math.abs(target - p.ms()) > (kind === 'seek' ? 1000 : TOL_MS);
    actionAt = now();
    if (kind === 'pause') {
      if (p.playing()) p.pause();
      if (far) p.seek(target);
    } else {
      if (far) p.seek(target);
      if (playAfter && !p.playing()) p.play();
      else if (!playAfter && p.playing()) p.pause();
    }
    H.bus.emit('sync:event', { kind, by: msg.from || 'Someone', ms, time: ms / 1000 });
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'play': case 'pause': case 'seek': return applyAction(msg);
      case 'sync': case 'tick': return applyHost(msg);
      case 'ad': return setMemberAd(msg.from || 'Someone', !!msg.on, msg.leftMs);
      case 'sync-request': return sendSyncSoon(); // no-op unless we are the host
      case 'hello': return sendSyncSoon();        // a guest just (re)joined
      default:
    }
  }

  function onStatus(s) {
    if (!s) return;
    const peers = Number(s.peerCount) || 0;
    if (S.role === 'host' && peers > lastPeers) sendSyncSoon();
    if (S.role === 'guest' && s.state === 'connected' && lastNetState !== 'connected') requestSync();
    if (s.state === 'idle' || s.state === 'error') clearRoom(); // left the party: nobody to wait for
    lastNetState = s.state;
    lastPeers = peers;
  }

  // Someone left mid-ad: stop waiting on them.
  function onRoster(r) {
    if (!r || !Array.isArray(r.names)) return;
    pruneAds(r.names);
    updateRoom();
  }

  function onGone() {
    resetBaseline();
    if (localAd) setLocalAd(false, null); // navigated away mid-ad: don't leave the room waiting on us
  }

  // 1s housekeeping: host announces a title change; forget stale ads.
  function houseKeeping() {
    if (location.href !== lastUrl) { lastUrl = location.href; sendSyncSoon(); }
    if (memberAds.size) { pruneAds(null); updateRoom(); }
  }

  // ---------- public API ----------
  const noteInput = () => { lastInput = now(); };
  function start() {
    if (started) return;
    started = true;
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, noteInput, true);
    unsubs = [
      H.bus.on('net:message', onMessage),
      H.bus.on('net:status', onStatus),
      H.bus.on('net:roster', onRoster),
      H.bus.on('player:state', onState),
      H.bus.on('player:ready', resetBaseline),
      H.bus.on('player:gone', onGone),
    ];
    timers = [setInterval(tickLoop, TICK_MS), setInterval(houseKeeping, 1000)];
  }

  function stop() {
    if (!started) return;
    started = false;
    if (localAd) setLocalAd(false, null);
    unsubs.forEach((off) => off());
    timers.forEach(clearInterval);
    for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, noteInput, true);
    unsubs = []; timers = [];
    clearTimeout(syncTimer);
    clearRoom();
    resetBaseline();
  }

  // 62 -> "1:02", 3753 -> "1:02:33"
  function fmt(seconds) {
    const s = Math.max(0, Math.floor(isFinite(Number(seconds)) ? Number(seconds) : 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  const fmtMs = (ms) => fmt((Number(ms) || 0) / 1000);

  H.sync = { start, stop, fmt, fmtMs, waiting: () => waiting.slice() };
})();
