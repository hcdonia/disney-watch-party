// MV3 service worker (PLAN.md v3 "UI"). Two jobs:
//  1. Open Chrome's side panel from the toolbar icon (setPanelBehavior).
//  2. Relay between the side panel and the Disney+ content script of the tab it is bound to.
//     Content script: runtime.connect({name:'hwp-page'}). Side panel: runtime.connect({name:'hwp-panel'})
//     then {type:'bind', tabId}. Page -> every panel bound to its tab; panel -> its tab's page.
// State is in memory only: if the worker restarts, every port drops and both sides reconnect.

const pages = new Map();   // tabId -> content-script Port
const panels = new Set();  // { port, tabId }

function enableActionClick() {
  try {
    const p = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    if (p && p.catch) p.catch((e) => console.warn('[WatchParty] setPanelBehavior failed', e));
  } catch (e) { console.warn('[WatchParty] setPanelBehavior failed', e); }
}
chrome.runtime.onInstalled.addListener(enableActionClick);
chrome.runtime.onStartup.addListener(enableActionClick);
enableActionClick(); // cheap and idempotent; covers a worker that starts for any other reason

function send(port, msg) {
  try { port.postMessage(msg); return true; } catch (_) { return false; }
}
function panelsFor(tabId) {
  const out = [];
  for (const p of panels) if (p.tabId === tabId) out.push(p);
  return out;
}
// Tell a page how many panels are watching it (drives its unread badge).
function tellPage(tabId) {
  const page = pages.get(tabId);
  if (page) send(page, { type: 'panels', count: panelsFor(tabId).length });
}

// ---------- port relay ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'hwp-page') onPage(port);
  else if (port.name === 'hwp-panel') onPanel(port);
});

function onPage(port) {
  const s = port.sender || {};
  const tabId = s.tab && s.tab.id;
  if (typeof tabId !== 'number' || (s.frameId || 0) !== 0) { try { port.disconnect(); } catch (_) {} return; }
  pages.set(tabId, port); // a reloaded page replaces its old port; the old one's late events are ignored
  port.onMessage.addListener((msg) => {
    if (pages.get(tabId) !== port || !msg || typeof msg !== 'object' || msg.type === 'ping') return;
    for (const p of panelsFor(tabId)) send(p.port, msg);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (pages.get(tabId) !== port) return;
    pages.delete(tabId);
    for (const p of panelsFor(tabId)) send(p.port, { type: 'no-page', tabId });
  });
  tellPage(tabId);
  for (const p of panelsFor(tabId)) send(p.port, { type: 'page-ready', tabId });
}

function onPanel(port) {
  const entry = { port, tabId: null };
  panels.add(entry);
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object' || msg.type === 'ping') return;
    if (msg.type === 'bind') {
      const prev = entry.tabId;
      entry.tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
      if (prev !== null && prev !== entry.tabId) tellPage(prev);
      if (entry.tabId !== null) tellPage(entry.tabId);
      send(port, { type: pages.has(entry.tabId) ? 'page-ready' : 'no-page', tabId: entry.tabId });
      return;
    }
    const page = entry.tabId !== null ? pages.get(entry.tabId) : null;
    if (!page || !send(page, msg)) send(port, { type: 'no-page', tabId: entry.tabId });
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    panels.delete(entry);
    if (entry.tabId !== null) tellPage(entry.tabId);
  });
}
