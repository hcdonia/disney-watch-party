// Shared state + event bus. Loaded first; every other module hangs off window.HWP.
(() => {
  if (window.HWP) return;
  const listeners = {};
  window.HWP = {
    VERSION: '2.0.0',
    state: {
      role: null,          // 'host' | 'guest' | null
      code: null,          // 4-char room code
      name: '',            // this viewer's display name
      connected: false,    // at least one live peer link
      peerNames: [],       // names of the other people in the room
      adMode: false,       // true while an ad is on screen locally
      controlMode: 'everyone', // 'everyone' | 'host' (who may play/pause/seek)
    },
    bus: {
      on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return () => HWP.bus.off(evt, fn); },
      off(evt, fn) { listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn); },
      emit(evt, ...args) { for (const fn of (listeners[evt] || []).slice()) { try { fn(...args); } catch (e) { HWP.log('listener error', evt, e); } } },
    },
    log(...a) { try { console.debug('[WatchParty]', ...a); } catch (_) {} },
  };
})();
