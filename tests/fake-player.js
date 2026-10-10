// Fake Disney+ main-world player for the harness. Mimics disney-web-player.mediaPlayer + ad-badge-overlay.
(() => {
  const info = { playheadPositionMs: 0, programDurationMs: 2523792, type: 'VOD' };
  const status = { currentState: 'PAUSED', playing: false, paused: true };
  let inAd = false, adTimer = null, adLeft = 0;
  const setStatus = (playing) => {
    status.playing = playing; status.paused = !playing;
    status.currentState = playing ? 'PLAYING' : 'PAUSED';
  };
  const vid = () => document.querySelector('#v');
  const badge = document.createElement('ad-badge-overlay');
  badge.overlayVisible = false;
  badge.localState = { adBadge: null };
  const setBadge = (on, leftMs) => {
    badge.overlayVisible = !!on;
    badge.localState = { adBadge: on ? { text: 'Ad ' + Math.ceil((leftMs || 0) / 1000) } : null };
  };

  const mediaPlayer = {
    timeline: { info },
    playbackStatus: status,
    seek(ms) {
      const q = window.__fakeQueuedAd;
      if (q) {
        window.__fakeQueuedAd = 0;
        window.__fakeAd(true, q);
        clearTimeout(adTimer);
        adTimer = setTimeout(() => { window.__fakeAd(false); info.playheadPositionMs = ms; }, q);
        return;
      }
      info.playheadPositionMs = ms;
    },
    play() { setStatus(true); const v = vid(); if (v) v.play().catch(() => {}); },
    pause() { setStatus(false); },
  };
  const stateStore = {
    getState: () => ({ ui: { milestones: { data: [
      { milestoneType: 'ad-video', milestoneTime: 691708 },
      { milestoneType: 'ad-video', milestoneTime: 1128208 },
    ] } } }),
  };

  class FakeDisneyPlayer extends HTMLElement {}
  customElements.define('disney-web-player', FakeDisneyPlayer);
  const el = document.createElement('disney-web-player');
  el.mediaPlayer = mediaPlayer;
  el.stateStore = stateStore;
  const mount = () => { document.body.appendChild(el); document.body.appendChild(badge); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), dt = now - last; last = now;
    if (status.playing && !inAd) info.playheadPositionMs += dt;
    if (inAd && adLeft > 0) adLeft = Math.max(0, adLeft - dt);
  }, 50);

  // Ad: playhead frozen, status stays PLAYING, badge on, real <video> keeps advancing.
  window.__fakeAd = (on, leftMs) => {
    inAd = !!on; adLeft = on ? (leftMs || 30000) : 0;
    setBadge(on, adLeft);
    const v = vid();
    if (on) { if (v) { v.loop = true; v.play().catch(() => {}); } setStatus(true); }
  };
  window.__fakeMs = () => info.playheadPositionMs;
  window.__fakePlaying = () => status.playing;
  window.__fakeInAd = () => inAd;
  window.__fakePlayer = mediaPlayer;
})();
