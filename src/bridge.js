// Disney Watch Party: page bridge. Runs in the PAGE's main world, not as a content script.
// src/player.js injects it as <script src="chrome-extension://.../src/bridge.js"> because content
// scripts live in an isolated world and cannot see the player's JS properties. It talks to
// player.js only through window.postMessage, and it must never throw into Disney+'s page.
//
// Facts measured live on disneyplus.com (2026-10-09, PLAN.md v3):
// - document.querySelector('disney-web-player').mediaPlayer is the real player API.
// - mediaPlayer.timeline.info.playheadPositionMs = PROGRAM position in ms; programDurationMs = title length.
// - mediaPlayer.seek(ms) takes MILLISECONDS. play() / pause() work.
// - mediaPlayer.playbackStatus.currentState is PLAYING / PAUSED / SEEKING / BUFFERING / ...
// - During an ad the playhead is FROZEN at the break's ms while <video>.currentTime keeps advancing
//   and the status stays PLAYING. <ad-badge-overlay>.overlayVisible is true while the "Ad 0:30" badge shows.
// - Ad breaks: el.stateStore.getState().ui.milestones.data, entries {milestoneType:'ad-video', milestoneTime}.
// - <video>.currentTime is NOT program time (resets on ads and reloads). Here it only feeds the ad-stall
//   check and the `v` debug field. Never sync on it.
//
// Out:  {hwp:'ready'} once the player is found, {hwp:'gone'} when it is lost (SPA navigation swaps it),
//       {hwp:'state', ms, durMs, status, playing, ad, adLeftMs, breaks, v} every 250ms while found.
// In:   {hwp:'cmd', op:'seek'|'play'|'pause', ms}.
(() => {
  'use strict';
  if (window.__hwpBridge) return; // injected twice (extension reload) => the first copy keeps running
  const dbg = { version: 3, last: null }; // inspect window.__hwpBridge.last in DevTools when probing live
  window.__hwpBridge = dbg;

  const POST_MS = 250;      // state cadence
  const FIND_MS = 500;      // retry cadence while the player is missing
  const BADGE_FIND_MS = 1000;
  const STALL_MS = 1500;    // playhead frozen this long while PLAYING...
  const STALL_V_S = 1;      // ...and <video> advanced more than this many seconds => an ad is playing
  const TAG = '[WatchParty bridge]';

  let host = null, mp = null, found = false, lastFind = 0;
  let badge = null, lastBadgeFind = 0, loggedBadge = false;
  const loggedKeySets = new Set();
  let stallMs = null, stallSince = 0, stallVAdv = 0, lastV = null; // ad-stall detector
  let errLogged = 0;

  const now = () => Date.now();
  const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }; // Number(null) is 0: guard it
  const post = (msg) => { try { window.postMessage(msg, '*'); } catch (_) {} };
  function logErr(where, e) { if (errLogged++ < 5) { try { console.debug(TAG, where, e); } catch (_) {} } }

  // ---------- finding the player ----------
  function findPlayer() {
    const el = document.querySelector('disney-web-player');
    let api = null;
    try { api = el && el.mediaPlayer; } catch (_) {}
    if (!el || !api || typeof api !== 'object') return false;
    host = el; mp = api; found = true;
    badge = null; resetStall();
    post({ hwp: 'ready' });
    return true;
  }
  // Same element, still in the document, still the same player object.
  function stillValid() {
    try { return !!host && host.isConnected && document.querySelector('disney-web-player') === host && host.mediaPlayer === mp; }
    catch (_) { return false; }
  }
  function lose() {
    host = null; mp = null; badge = null; resetStall();
    if (found) { found = false; post({ hwp: 'gone' }); }
  }

  // Disney+ keeps a dummy <video> (readyState 0, 0x0) next to the real one: prefer visible + loaded, largest.
  function pickVideo() {
    let best = null, area = -1, bestReady = false;
    for (const v of document.querySelectorAll('video')) {
      const a = v.offsetWidth * v.offsetHeight;
      if (a <= 0) continue;
      const ready = v.readyState > 0;
      if ((ready && !bestReady) || (ready === bestReady && a > area)) { best = v; area = a; bestReady = ready; }
    }
    return best;
  }

  // ---------- ads ----------
  // <ad-badge-overlay> may sit in the light DOM or inside the player's (open) shadow roots.
  function deepFind(root, sel, budget) {
    const stack = [root];
    while (stack.length && budget.n > 0) {
      const r = stack.pop();
      if (!r || !r.querySelectorAll) continue;
      const hit = r.querySelector(sel);
      if (hit) return hit;
      for (const el of r.querySelectorAll('*')) {
        if (--budget.n <= 0) break;
        if (el.shadowRoot) stack.push(el.shadowRoot);
      }
    }
    return null;
  }
  function findBadge() {
    if (badge && badge.isConnected) return badge;
    badge = null;
    if (now() - lastBadgeFind < BADGE_FIND_MS) return null;
    lastBadgeFind = now();
    badge = document.querySelector('ad-badge-overlay') || deepFind(host || document, 'ad-badge-overlay', { n: 4000 });
    if (badge && !loggedBadge) {
      loggedBadge = true;
      let ls = null;
      try { ls = badge.localState; } catch (_) {}
      try { console.debug(TAG, 'ad-badge-overlay found; localState keys:', ls && typeof ls === 'object' ? Object.keys(ls) : ls); } catch (_) {}
    }
    return badge;
  }

  // Text of an element including nested shadow roots (the badge's "Ad 0:30" lives in one).
  function deepText(el) {
    let out = '';
    const stack = [el.shadowRoot || el];
    let n = 200;
    while (stack.length && n-- > 0) {
      const r = stack.pop();
      if (!r) continue;
      out += ' ' + (r.textContent || '');
      if (r.querySelectorAll) for (const c of r.querySelectorAll('*')) if (c.shadowRoot) stack.push(c.shadowRoot);
    }
    return out;
  }
  // "0:30" / "1:05" => ms
  function parseClock(s) {
    const m = /(\d{1,2}):(\d{2})(?!\d)/.exec(String(s || ''));
    return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
  }

  // Seconds left in the ad, best effort. localState.adBadge's shape is unknown, so its keys are logged
  // (once per distinct key set) for whoever probes the live site next. Falls back to the badge's text.
  function readAdLeftMs(b) {
    let st = null;
    try { st = b.localState && b.localState.adBadge; } catch (_) {}
    if (st && typeof st === 'object') {
      const keys = Object.keys(st);
      const sig = keys.slice().sort().join(',');
      if (!loggedKeySets.has(sig) && loggedKeySets.size < 6) {
        loggedKeySets.add(sig);
        let sample = '';
        try { sample = JSON.stringify(st).slice(0, 400); } catch (_) {}
        try { console.debug(TAG, 'localState.adBadge keys:', keys, sample); } catch (_) {}
      }
      for (const k of keys) {
        if (!/remain|countdown|time_?left|sec(ond)?s_?left|ms_?left/i.test(k)) continue;
        const v = st[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return /ms/i.test(k) || v > 600 ? Math.round(v) : Math.round(v * 1000); // seconds vs ms guess
        const c = parseClock(v);
        if (c != null) return c;
      }
      for (const k of keys) if (typeof st[k] === 'string') { const c = parseClock(st[k]); if (c != null) return c; }
    }
    try { return parseClock(deepText(b)); } catch (_) { return null; }
  }

  function resetStall() { stallMs = null; stallSince = 0; stallVAdv = 0; lastV = null; }
  // Ad heuristic for when the badge is missing: PLAYING, playhead frozen >= 1.5s, video advanced > 1s.
  // Video advance is summed over small positive steps, so a currentTime reset at the ad's start can't hide it.
  function stalled(ms, status, v, t) {
    if (ms !== stallMs) { stallMs = ms; stallSince = t; stallVAdv = 0; }
    else if (v != null && lastV != null) { const dv = v - lastV; if (dv > 0 && dv < 2) stallVAdv += dv; }
    lastV = v;
    return status === 'PLAYING' && ms != null && t - stallSince >= STALL_MS && stallVAdv > STALL_V_S;
  }

  function readBreaks() {
    try {
      const st = host.stateStore && typeof host.stateStore.getState === 'function' ? host.stateStore.getState() : null;
      let data = st && st.ui && st.ui.milestones && st.ui.milestones.data;
      if (!data || typeof data !== 'object') return [];
      if (!Array.isArray(data)) data = Object.values(data);
      const out = [];
      for (const m of data) {
        if (m && m.milestoneType === 'ad-video') { const ms = num(m.milestoneTime); if (ms != null) out.push(Math.round(ms)); }
        if (out.length >= 50) break;
      }
      return out;
    } catch (_) { return []; }
  }

  // ---------- the 250ms loop ----------
  function loop() {
    try {
      const t = now();
      if (found && !stillValid()) lose();
      if (!found) {
        if (t - lastFind < FIND_MS) return;
        lastFind = t;
        if (!findPlayer()) return;
      }
      let info = {};
      try { info = (mp.timeline && mp.timeline.info) || {}; } catch (_) {}
      const rawMs = num(info.playheadPositionMs);
      const ms = rawMs == null ? null : Math.round(rawMs);
      const durMs = num(info.programDurationMs != null ? info.programDurationMs : mp.programDurationMs);
      let ps = {};
      try { ps = mp.playbackStatus || {}; } catch (_) {}
      const status = typeof ps.currentState === 'string' ? ps.currentState.toUpperCase() : null;
      const playing = typeof ps.playing === 'boolean' ? ps.playing : status === 'PLAYING';
      const vid = pickVideo();
      const v = vid ? num(vid.currentTime) : null;

      const b = findBadge();
      let badgeOn = false;
      try { badgeOn = !!b && b.overlayVisible === true; } catch (_) {}
      const ad = badgeOn || stalled(ms, status, v, t);
      const adLeftMs = ad && b ? readAdLeftMs(b) : null;

      const msg = { hwp: 'state', ms, durMs, status, playing, ad, adLeftMs, breaks: readBreaks(), v };
      dbg.last = msg;
      post(msg);
    } catch (e) { logErr('loop', e); }
  }

  // ---------- commands from player.js ----------
  function quiet(r) { if (r && typeof r.catch === 'function') r.catch((e) => logErr('player promise', e)); }
  window.addEventListener('message', (e) => {
    try {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || d.hwp !== 'cmd') return;
      if (!found || !mp) return;
      if (d.op === 'seek') {
        let ms = num(d.ms);
        if (ms == null || ms < 0) return;
        let dur = null;
        try { dur = num(mp.timeline && mp.timeline.info && mp.timeline.info.programDurationMs); } catch (_) {}
        if (dur && dur > 2000) ms = Math.min(ms, dur - 1000);
        resetStall();
        quiet(mp.seek(Math.round(ms))); // MILLISECONDS
      } else if (d.op === 'play') quiet(mp.play());
      else if (d.op === 'pause') quiet(mp.pause());
    } catch (err) { logErr('cmd', err); }
  });

  setInterval(loop, POST_MS);
  loop();
})();
