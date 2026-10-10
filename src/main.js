// Boot: wire modules, restore a session after a reload.
(() => {
  if (window.__hwpLoaded) return;
  window.__hwpLoaded = true;
  const STORE_KEY = 'hwp-session';

  HWP.session = {
    save() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ role: HWP.state.role, code: HWP.state.code })); } catch (_) {} },
    clear() { try { sessionStorage.removeItem(STORE_KEY); } catch (_) {} },
    load() { try { return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch (_) { return null; } },
  };

  HWP.ui.init();
  HWP.sync.start();

  const saved = HWP.session.load();
  if (saved && saved.code && saved.role) {
    if (saved.role === 'host') HWP.net.host(saved.code);
    else HWP.net.join(saved.code);
  }
})();
