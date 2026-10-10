// Disney Watch Party: player adapter (isolated world). Injects src/bridge.js into the page, turns its
// window.postMessage reports into HWP.bus events, and sends it play/pause/seek commands.
//
// Everything here is Disney+ PROGRAM time in milliseconds (mediaPlayer.timeline.info.playheadPositionMs),
// never <video>.currentTime (not program time on Disney+; see PLAN.md v3 facts).
//
// Bus: 'player:ready' (player found), 'player:gone' (lost; SPA navigation), 'player:state' (s) every ~250ms,
//      s = { ms, durMs, status, playing, ad, adLeftMs, breaks: [ms], v, at } (at = when we received it).
// API: HWP.player = { ready(), ms(), playing(), ad(), adLeftMs(), seek(ms), play(), pause(),
//                     last, lastCmd: {op, ms, at}, lastCmds: {seek, play, pause} }
// lastCmd / lastCmds let sync.js tell the state changes it caused from the ones a person caused.
(() => {
  const H = window.HWP;
  if (!H || H.player) return;

  const STALE_MS = 5000;        // no report for this long => not ready (hidden tabs throttle timers to 1/s)
  const EXTRAPOLATE_MAX_MS = 1000;

  let isReady = false;

  // ---------- injection ----------
  // Needs manifest web_accessible_resources for src/bridge.js. On a plain test page there is no
  // chrome.runtime: the page loads bridge.js itself, so skip. The bridge guards against double runs.
  function inject() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.getURL !== 'function') return;
      if (document.querySelector('script[data-hwp-bridge]')) return;
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('src/bridge.js');
      s.dataset.hwpBridge = '1';
      s.onload = s.onerror = () => s.remove();
      document.documentElement.appendChild(s);
    } catch (e) { H.log('player: bridge inject failed', e); }
  }

  // ---------- reports from the bridge ----------
  const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }; // Number(null) is 0: guard it
  function clean(d) {
    return {
      ms: num(d.ms) == null ? null : Math.round(num(d.ms)),
      durMs: num(d.durMs),
      status: typeof d.status === 'string' ? d.status.toUpperCase() : null,
      playing: !!d.playing,
      ad: !!d.ad,
      adLeftMs: num(d.adLeftMs),
      breaks: Array.isArray(d.breaks) ? d.breaks.map(num).filter((x) => x != null).slice(0, 50) : [],
      v: num(d.v),
      at: Date.now(),
    };
  }
  function markReady() { if (!isReady) { isReady = true; H.bus.emit('player:ready'); } }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.hwp !== 'string') return;
    if (d.hwp === 'state') {
      const s = clean(d);
      markReady(); // the bridge may have said 'ready' before this content script loaded
      P.last = s;
      H.bus.emit('player:state', s);
    } else if (d.hwp === 'ready') {
      markReady();
    } else if (d.hwp === 'gone') {
      P.last = null;
      if (isReady) { isReady = false; H.bus.emit('player:gone'); }
    }
  });

  // ---------- commands to the bridge ----------
  function cmd(op, ms) {
    const c = { op, ms: op === 'seek' ? Math.max(0, Math.round(ms)) : P.ms(), at: Date.now() };
    P.lastCmd = c;
    P.lastCmds[op] = c;
    try { window.postMessage({ hwp: 'cmd', op, ms: c.ms }, '*'); } catch (_) { return false; }
    return true;
  }

  const P = {
    last: null,
    lastCmd: null,
    lastCmds: { seek: null, play: null, pause: null },
    ready: () => isReady && !!P.last && P.last.ms != null && Date.now() - P.last.at < STALE_MS,
    // Program ms now. Reports are up to 250ms old, so while really playing (not in an ad) add the elapsed time.
    ms() {
      const s = P.last;
      if (!s || s.ms == null) return null;
      if (s.playing && s.status === 'PLAYING' && !s.ad) return s.ms + Math.min(Math.max(0, Date.now() - s.at), EXTRAPOLATE_MAX_MS);
      return s.ms;
    },
    playing: () => !!(P.last && P.last.playing),
    ad: () => !!(P.last && P.last.ad),
    adLeftMs: () => (P.last ? P.last.adLeftMs : null),
    seek(ms) { const n = num(ms); return n == null ? false : cmd('seek', n); }, // MILLISECONDS
    play: () => cmd('play'),
    pause: () => cmd('pause'),
  };
  H.player = P;

  inject();
})();
