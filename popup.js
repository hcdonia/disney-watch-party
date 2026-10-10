document.getElementById('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;
document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.disneyplus.com/' });
  window.close();
});
