import { chromium } from '/Users/hunterdonia/Documents/Coding Projects/Hunter Donia Website/node_modules/playwright/index.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const dir = process.cwd();
const srv = http.createServer((req, res) => {
  const f = path.join(dir, req.url.split('?')[0].replace(/^\//,'') || 'test.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const types = {'.html':'text/html','.js':'text/javascript','.mp4':'video/mp4','.css':'text/css'};
  const size = fs.statSync(f).size, ct = types[path.extname(f)] || 'application/octet-stream';
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { const a=+m[1], b=m[2]?+m[2]:size-1; res.writeHead(206, {'content-type':ct,'content-range':`bytes ${a}-${b}/${size}`,'content-length':b-a+1,'accept-ranges':'bytes'}); return fs.createReadStream(f,{start:a,end:b}).pipe(res); }
  res.writeHead(200, {'content-type': ct, 'content-length': size, 'accept-ranges':'bytes'});
  fs.createReadStream(f).pipe(res);
}).listen(4747);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const host = await browser.newPage(); const guest = await browser.newPage();
await host.goto('http://localhost:4747/test.html'); await guest.goto('http://localhost:4747/test.html');
await host.click('#hwp-host'); await sleep(3000);
const code = await host.textContent('#hwp-panel .hwp-code');
console.log('code', code, '| host status:', await host.textContent('#hwp-panel .hwp-body'));
await guest.fill('#hwp-code', code.trim()); await guest.click("#hwp-join"); for (let i=0;i<30;i++){ await sleep(1000); if ((await guest.textContent("#hwp-panel .hwp-body")).includes("Connected")) { console.log("connected after", i+1, "s"); break; } }
console.log('guest status:', (await guest.textContent('#hwp-panel .hwp-status')));
const hostOk = (await host.textContent('#hwp-panel .hwp-body')).includes('Connected');
console.log('host sees connected:', hostOk);
// 1. host plays
await host.evaluate(() => document.querySelector('#v').play()); await sleep(2000);
console.log('guest paused after host play:', await guest.evaluate(() => document.querySelector('#v').paused));
// 2. host seeks to 30
await host.evaluate(() => { document.querySelector('#v').currentTime = 30; }); await sleep(2500);
console.log('host time:', await host.evaluate(() => document.querySelector('#v').currentTime.toFixed(1)), 'guest time after host seek to 30:', await guest.evaluate(() => document.querySelector('#v').currentTime.toFixed(1)));
// 3. guest pauses -> host pauses
await guest.evaluate(() => document.querySelector('#v').pause()); await sleep(2000);
console.log('host paused after guest pause:', await host.evaluate(() => document.querySelector('#v').paused));
// 4. chat both ways
await host.fill('#hwp-msg', 'hi babe'); await host.press('#hwp-msg', 'Enter');
await guest.fill('#hwp-msg', 'hey!!'); await guest.press('#hwp-msg', 'Enter'); await sleep(1500);
console.log('guest chat:', await guest.textContent('#hwp-chat'));
console.log('host chat:', await host.textContent('#hwp-chat'));
// 5. drift: nudge guest 10s off while playing, host tick should pull it back
await host.evaluate(() => document.querySelector('#v').play()); await sleep(1500);
await guest.evaluate(() => { window.__hwpT = 1; const v=document.querySelector('#v'); v.currentTime = v.currentTime + 10; }); await sleep(6000);
const ht = await host.evaluate(() => document.querySelector('#v').currentTime), gt = await guest.evaluate(() => document.querySelector('#v').currentTime);
console.log('sidebar style on:', await host.evaluate(() => !!document.getElementById('hwp-layout')), 'panel width:', await host.evaluate(() => document.getElementById('hwp-panel').offsetWidth));
console.log('drift after correction (s):', Math.abs(ht-gt).toFixed(1));
await browser.close(); srv.close();
