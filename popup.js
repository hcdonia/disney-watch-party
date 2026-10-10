document.getElementById('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;

// Look up the active tab up front: sidePanel.open must run synchronously inside the click
// (an await before it loses the user gesture and Chrome refuses to open the panel).
let tab = null;
chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { tab = t || null; }, () => {});

document.getElementById('chat').addEventListener('click', () => {
  const err = document.getElementById('err');
  if (!tab) { err.textContent = 'Could not find this tab. Try again.'; return; }
  try {
    chrome.sidePanel.open({ tabId: tab.id }).then(
      () => window.close(),
      (e) => { err.textContent = 'Could not open the chat: ' + ((e && e.message) || e); },
    );
  } catch (e) {
    err.textContent = 'Could not open the chat: ' + ((e && e.message) || e);
  }
});

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.disneyplus.com/' });
  window.close();
});
