// Watch Party: Prime Video page bridge. Same job and same messages as src/bridge.js (Disney+), for
// amazon.com/gp/video and primevideo.com. Runs in the PAGE's main world as a manifest content script
// ("world": "MAIN", document_start) so its request hooks are in place before Prime's player loads.
// It talks to src/player.js only through window.postMessage, and it must never throw into the page.
//
// How Prime's web player works (2026-11, from PreMiD's maintained Prime Video activity, Dreamlinerm's
// auto-skip and NCOverlay; see PLAN.md v4):
// - The real player is a plain <video> inside div[id^=dv-web-player] (several can coexist; an old episode
//   stays in the DOM paused and hidden). Trailers use video.tst-video-overlay-player-html5: never that one.
// - <video>.currentTime is NOT program time: the timeline is the Prime Video intro jingle (~6s), then the
//   title with every ad break spliced in (server-side ad insertion). Ads play in the same <video>.
// - Get*PlaybackResources (titleId=GTI) returns vodPlaylistedPlaybackUrls.result.playbackUrls:
//   intraTitlePlaylist = items in order; type 'Main' = the title (startMs/endMs), items before the first
//   Main = the jingle, type 'Remote' = an ad break (urlsInPriorityOrder[0] carries adMarkerId=...).
//   fullTitleDurationMs = length without ads (jingle included).
// - /cdp/getVideoAds?adMarkerId=M returns playlist[].description.duration ("00:00:30.000") per ad.
// - /playback/pes/UpdateSession (sent on play/pause/seek and every few minutes) carries
//   streamInfo.vodProgressInfo.currentProgressTime (ISO duration) = the real title position: an anchor.
// - During an ad the title position is frozen at the break while currentTime keeps going (like Disney+).
//   The visible ad timer is .atvwebplayersdk-ad-timer-remaining-time ("0:30").
//
// Program position = currentTime - (jingle + ad time already behind us) + calibration from the last anchor.
// Ads the playlist didn't explain but the on-screen ad timer showed are remembered in video time, so the
// position stays right even if the page loaded before we could see its requests.
//
// Out:  {hwp:'ready'}, {hwp:'gone'},
//       {hwp:'state', ms, durMs, status, playing, ad, adLeftMs, breaks, v, title} every 250ms while found.
// In:   {hwp:'cmd', op:'seek'|'play'|'pause', ms}.
(() => {
  'use strict';
  if (window.__hwpBridge) return;
  const dbg = { version: 4, site: 'prime', last: null, titles: null }; // window.__hwpBridge in DevTools
  window.__hwpBridge = dbg;

  const POST_MS = 250;
  const MAX_OFFSET_S = 3600;      // a jingle + ads offset bigger than this is nonsense: ignore the model
  const DURATION_TOL_S = 2;       // <video>.duration vs the title's ad-free length
  const MAX_TITLE_ADS_S = 900;    // ...plus at most this much ad time
  const MAX_TITLES = 6;
  const AD_TIMER_SEL = '.atvwebplayersdk-ad-timer-remaining-time, .atvwebplayersdk-adtimeindicator-text';
  const PLAYBACK_RE = /\/playback\/prs\/Get\w*PlaybackResources/;
  const SESSION_RE = /\/playback\/pes\/UpdateSession/;
  const ADS_RE = /\/cdp\/getVideoAds/;
  const TAG = '[WatchParty prime]';

  const titles = new Map();       // gti -> { gti, intro, full, breaks: [{cue, marker, a}], anchor: {ct, cp} }
  const adDurations = new Map();  // adMarkerId -> seconds (the ads answer can come before or after the playlist)
  let activeGti = null;
  let srcKey = null, srcGti = null; // the title locked to the current video stream (see pickTitle)
  let observed = [];              // ads seen on screen that the playlist didn't cover: [{vs, a}] in video seconds
  let domAdStart = null, lastDomV = null;
  let vid = null, found = false, errLogged = 0;

  const now = () => Date.now();
  const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
  const post = (msg) => { try { window.postMessage(msg, '*'); } catch (_) {} };
  function logErr(where, e) { if (errLogged++ < 5) { try { console.debug(TAG, where, e); } catch (_) {} } }
  function parseJson(t) { try { return typeof t === 'string' && t ? JSON.parse(t) : null; } catch (_) { return null; } }
  function isoSeconds(v) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(v || ''));
    return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : null;
  }
  // "00:00:30.000" / "0:30" => seconds
  function clockSeconds(v) {
    const parts = String(v || '').trim().split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
  }
  const adMarker = (s) => { const m = /adMarkerId=([^&]+)/.exec(String(s || '')); return m ? m[1] : null; };

  // ---------- the player's requests ----------
  function onPlayback(url, json) {
    let gti = null;
    try { gti = new URL(url, location.href).searchParams.get('titleId'); } catch (_) {}
    const result = json && json.vodPlaylistedPlaybackUrls && json.vodPlaylistedPlaybackUrls.result;
    const list = result && result.playbackUrls && result.playbackUrls.intraTitlePlaylist;
    if (!gti || !Array.isArray(list)) return;
    let pos = 0, intro = 0, seenMain = false;
    const breaks = [];
    for (const item of list) {
      if (!item) continue;
      if (item.type === 'Remote') {
        const marker = adMarker(item.urlsInPriorityOrder && item.urlsInPriorityOrder[0]);
        breaks.push({ cue: pos, marker, a: marker ? adDurations.get(marker) || 0 : 0 });
        continue;
      }
      const s = num(item.startMs), e = num(item.endMs);
      if (s != null && e != null) {
        if (!seenMain && item.type !== 'Main') intro += (e - s) / 1000;
        pos = e / 1000;
      }
      if (item.type === 'Main') seenMain = true;
    }
    const full = num(result.playbackUrls.fullTitleDurationMs);
    titles.delete(gti);
    titles.set(gti, { gti, intro, full: full == null ? null : full / 1000, breaks, anchor: null });
    if (titles.size > MAX_TITLES) titles.delete(titles.keys().next().value);
    pickTitle();
  }

  function onAds(url, json) {
    const marker = adMarker(url);
    if (!marker || !json || !Array.isArray(json.playlist)) return;
    let total = 0;
    for (const ad of json.playlist) { const s = clockSeconds(ad && ad.description && ad.description.duration); if (s) total += s; }
    adDurations.set(marker, total);
    for (const t of titles.values()) for (const b of t.breaks) if (b.marker === marker) b.a = total;
  }

  // Read at request time, so currentTime and the reported position are from the same moment.
  function onSession(body) {
    const info = parseJson(body);
    const vod = info && info.streamInfo && info.streamInfo.vodProgressInfo;
    const cp = vod ? isoSeconds(vod.currentProgressTime) : null;
    const v = pickVideo();
    pickTitle();
    if (cp == null || !v) return;
    const ct = v.currentTime, gap = ct - cp;
    if (!(gap >= -1 && gap <= MAX_OFFSET_S)) return;
    const st = activeGti ? titles.get(activeGti) : null;
    if (st) st.anchor = { ct, cp };
    else fallbackAnchor = { ct, cp };
  }
  let fallbackAnchor = null; // anchor while no playlist is known (page loaded before our hooks saw it)

  function track(url, reqBody, resText) {
    try {
      if (PLAYBACK_RE.test(url)) onPlayback(url, parseJson(resText));
      else if (ADS_RE.test(url)) onAds(url, parseJson(resText));
    } catch (e) { logErr('track', e); }
  }

  // fetch + XHR hooks. They only read; the player always gets its own response untouched.
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const req = origFetch.apply(this, arguments);
        try {
          const url = String((input && input.url) || input);
          if (SESSION_RE.test(url)) onSession(init && typeof init.body === 'string' ? init.body : null);
          else if (PLAYBACK_RE.test(url) || ADS_RE.test(url)) {
            req.then((r) => r.clone().text()).then((t) => track(url, null, t)).catch(() => {});
          }
        } catch (_) {}
        return req;
      };
    }
  } catch (e) { logErr('fetch hook', e); }
  try {
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR) {
      const open = XHR.open, send = XHR.send;
      XHR.open = function (method, url) { try { this.__hwpUrl = String(url); } catch (_) {} return open.apply(this, arguments); };
      XHR.send = function (body) {
        try {
          const url = this.__hwpUrl || '';
          if (SESSION_RE.test(url)) onSession(typeof body === 'string' ? body : null);
          else if (PLAYBACK_RE.test(url) || ADS_RE.test(url)) {
            this.addEventListener('load', () => {
              try { if (this.status === 200 && (this.responseType === '' || this.responseType === 'text')) track(this.responseURL || url, null, this.responseText); } catch (_) {}
            });
          }
        } catch (_) {}
        return send.apply(this, arguments);
      };
    }
  } catch (e) { logErr('xhr hook', e); }

  // ---------- finding the player ----------
  function pickVideo() {
    const all = [...document.querySelectorAll('div[id^="dv-web-player"] video')].filter((v) => !v.classList.contains('tst-video-overlay-player-html5') && (v.currentSrc || v.src));
    if (all.length <= 1) return all[0] || null;
    const shown = all.filter((v) => v.clientWidth > 0 && v.clientHeight > 0);
    return shown.find((v) => !v.paused) || all.find((v) => !v.paused) || shown[shown.length - 1] || all[all.length - 1];
  }
  // The player overlay is open and this video is on screen (closing the player hides it, keeps it in the DOM).
  function visible(v) {
    if (!v || !v.isConnected || v.clientWidth <= 0 || v.clientHeight <= 0) return false;
    const box = v.closest('div[id^="dv-web-player"]');
    try { return !box || getComputedStyle(box).display !== 'none'; } catch (_) { return true; }
  }

  // The title this <video> plays: the newest one whose ad-free length fits its duration. Locked to the stream
  // (currentSrc) once its duration is known, because near the end of an episode the player prefetches the
  // next one, which would otherwise win as "newest" while the current one is still playing.
  function pickTitle() {
    const v = vid || pickVideo();
    const key = v ? v.currentSrc || v.src || '' : '';
    const hasDur = !!v && Number.isFinite(v.duration);
    const fits = (g) => { const t = titles.get(g), f = t && t.full; return hasDur && f != null && v.duration - f >= -DURATION_TOL_S && v.duration - f <= MAX_TITLE_ADS_S; };
    let pick;
    if (key && key === srcKey && titles.has(srcGti) && fits(srcGti)) pick = srcGti;
    else {
      const ids = [...titles.keys()].reverse();
      pick = ids.find(fits) || ids[0] || null;
      if (key && pick && fits(pick)) { srcKey = key; srcGti = pick; }
    }
    if (pick !== activeGti) { activeGti = pick; observed = []; }
  }

  // ---------- timeline math ----------
  // Ad time behind video time ct (an ad in progress counts only its played part), plus the jingle.
  function rawOffset(st, ct) {
    let ads = 0, inAd = false, adLeft = null;
    if (st) {
      for (const b of st.breaks) {
        if (!(b.a > 0)) continue;
        const start = b.cue + ads;
        if (ct >= start + b.a) { ads += b.a; continue; }
        if (ct > start) { ads += ct - start; inAd = true; adLeft = start + b.a - ct; }
        break;
      }
    }
    for (const o of observed) {
      if (ct >= o.vs + o.a) ads += o.a;
      else if (ct > o.vs) ads += ct - o.vs;
    }
    return { offset: (st ? st.intro : 0) + ads, inAd, adLeft };
  }
  function calibration(st) {
    const a = st ? st.anchor : fallbackAnchor;
    if (!a) return 0;
    const c = (a.ct - a.cp) - rawOffset(st, a.ct).offset;
    return Math.abs(c) <= MAX_OFFSET_S ? c : 0;
  }
  function totalOffset(st, ct) {
    const r = rawOffset(st, ct);
    let off = r.offset + calibration(st);
    if (!(off >= 0 && off <= MAX_OFFSET_S)) off = 0;
    return { offset: Math.min(off, ct), inAd: r.inAd, adLeft: r.adLeft };
  }
  // Video time for program seconds p: solve ct = p + offset(ct). Monotone, so a few rounds settle it.
  function videoTimeFor(st, p) {
    let ct = p + totalOffset(st, p).offset;
    for (let i = 0; i < 8; i++) {
      const next = p + totalOffset(st, ct).offset;
      if (Math.abs(next - ct) < 0.01) break;
      ct = next;
    }
    return ct;
  }

  // ---------- on-screen ad timer ----------
  function domAd() {
    for (const el of document.querySelectorAll(AD_TIMER_SEL)) {
      let shown = false;
      try { shown = typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null; } catch (_) {}
      if (!shown) continue;
      const m = /(\d{1,2}):(\d{2})(?!\d)/.exec(el.textContent || '');
      return { leftMs: m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null };
    }
    return null;
  }

  // ---------- the 250ms loop ----------
  function loop() {
    try {
      const v = pickVideo();
      if (!visible(v)) {
        vid = null; domAdStart = null; lastDomV = null;
        if (found) { found = false; post({ hwp: 'gone' }); }
        return;
      }
      if (v !== vid) { vid = v; observed = []; domAdStart = null; lastDomV = null; pickTitle(); }
      if (!found) { found = true; post({ hwp: 'ready' }); }

      pickTitle();
      const st = activeGti ? titles.get(activeGti) : null;
      const ct = num(v.currentTime) || 0;
      const tl = totalOffset(st, ct);
      const screenAd = domAd();

      // An ad on screen the playlist didn't predict: remember it in video time so the position holds still.
      if (screenAd && !tl.inAd) {
        if (domAdStart == null || ct < lastDomV - 1) { domAdStart = ct; observed.push({ vs: ct, a: 0 }); }
        const o = observed[observed.length - 1];
        o.a = Math.max(o.a, ct - o.vs);
        lastDomV = ct;
      } else { domAdStart = null; lastDomV = null; }

      const off = totalOffset(st, ct);
      const ad = off.inAd || !!screenAd;
      const ms = Math.max(0, Math.round((ct - off.offset) * 1000));
      let durMs = null;
      if (st && st.full != null) durMs = Math.round((st.full - st.intro) * 1000);
      else if (Number.isFinite(v.duration)) durMs = Math.round((v.duration - off.offset) * 1000);
      const adLeftMs = !ad ? null : off.adLeft != null ? Math.round(off.adLeft * 1000) : screenAd ? screenAd.leftMs : null;
      const playing = !v.paused && !v.ended;
      const status = v.seeking ? 'SEEKING' : !playing ? 'PAUSED' : v.readyState < 3 ? 'BUFFERING' : 'PLAYING';
      const breaks = st ? st.breaks.map((b) => Math.round((b.cue - st.intro) * 1000)).filter((b) => b >= 0).slice(0, 50) : [];

      const msg = { hwp: 'state', ms, durMs, status, playing, ad, adLeftMs, breaks, v: ct, title: activeGti };
      dbg.last = msg;
      dbg.titles = titles;
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
      const v = vid;
      if (!found || !v) return;
      if (d.op === 'seek') {
        const ms = num(d.ms);
        if (ms == null || ms < 0) return;
        const st = activeGti ? titles.get(activeGti) : null;
        let ct = videoTimeFor(st, ms / 1000);
        if (Number.isFinite(v.duration) && v.duration > 2) ct = Math.min(ct, v.duration - 1);
        v.currentTime = Math.max(0, ct);
      } else if (d.op === 'play') quiet(v.play());
      else if (d.op === 'pause') v.pause();
    } catch (err) { logErr('cmd', err); }
  });

  setInterval(loop, POST_MS);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loop, { once: true });
  else loop();
})();
