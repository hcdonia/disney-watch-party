// v3 end-to-end harness: 2-3 headless pages over the real public PeerJS server, fake Disney+ player.
// Run: node tests/run.mjs
import { chromium } from '/Users/hunterdonia/Documents/Coding Projects/Hunter Donia Website/node_modules/playwright/index.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://localhost:4747/tests/test.html';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(f).size, ct = types[path.extname(f)] || 'application/octet-stream';
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = +m[1], b = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'content-type': ct, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' });
    return fs.createReadStream(f, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { 'content-type': ct, 'content-length': size, 'accept-ranges': 'bytes' });
  fs.createReadStream(f).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (_) {} await sleep(250); }
  try { return !!(await fn()); } catch (_) { return false; }
}
let fails = 0;
function report(name, ok, info) { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info || ''}`); }

const ms = (p) => p.evaluate(() => window.__fakeMs());
const playing = (p) => p.evaluate(() => window.__fakePlaying());
const userPlay = (p) => p.evaluate(() => document.querySelector('disney-web-player').mediaPlayer.play());
const userPause = (p) => p.evaluate(() => document.querySelector('disney-web-player').mediaPlayer.pause());
const userSeek = (p, t) => p.evaluate((t) => document.querySelector('disney-web-player').mediaPlayer.seek(t), t);
const connected = (p) => p.evaluate(() => !!HWP.state.connected);
const gotMsg = (p, pred) => p.evaluate((src) => window.__hwpEvents.some((e) => e.name === 'net:message' && (new Function('m', 'return (' + src + ')(m)'))(e.payload)), pred.toString());
const waitingNames = (p) => p.evaluate(() => { const l = window.__hwpEvents.filter((e) => e.name === 'sync:waiting'); const all = new Set(); l.forEach((e) => ((e.payload && e.payload.names) || []).forEach((n) => all.add(n))); return [...all]; });

async function newPage(browser) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(URL_);
  await p.waitForFunction(() => window.HWP && HWP.net && HWP.sync && HWP.player, null, { timeout: 10000 });
  return p;
}
const genCode = () => 'T' + Math.random().toString(36).slice(2, 5).toUpperCase();
async function startHost(p, name) {
  const code = genCode();
  await p.evaluate(([n, c]) => { HWP.state.name = n; HWP.net.host(c); }, [name, code]);
  await waitFor(() => p.evaluate(() => HWP.state.role === 'host'), 10000);
  return code;
}
async function joinGuest(p, name, code) {
  await p.evaluate(([n, c]) => { HWP.state.name = n; HWP.net.join(c); }, [name, code]);
  return waitFor(() => connected(p), 30000);
}
const sendChat = (p, text) => p.evaluate((t) => HWP.net.send({ type: 'chat', text: t }), text);
const hasChat = (p, text) => gotMsg(p, `(m) => m && m.type === 'chat' && JSON.stringify(m).includes(${JSON.stringify(text)})`);

async function scenario(name, fn) {
  try { await fn(); } catch (e) { report(name, false, 'threw: ' + e.message); }
}

async function twoParty(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    const ok = await joinGuest(guest, 'Pal', code);
    report('1.0 connect', ok && await waitFor(() => connected(host), 10000), `code=${code}`);
    if (!ok) return;
    await userPlay(host);
    report('1.1 host play -> guest playing within 2s', await waitFor(() => playing(guest), 2000), `guestPlaying=${await playing(guest)}`);
    await userSeek(host, 1300000);
    const seekOk = await waitFor(async () => Math.abs((await ms(host)) - (await ms(guest))) < 1500 && (await ms(guest)) > 1290000, 3000);
    report('1.2 host seek 1,300,000 -> guest within 1500ms', seekOk, `host=${Math.round(await ms(host))} guest=${Math.round(await ms(guest))}`);
    await userPause(guest);
    report('1.3 guest pause -> host paused within 2s', await waitFor(async () => !(await playing(host)), 2000), `hostPlaying=${await playing(host)}`);
    await sendChat(host, 'hi from host'); await sendChat(guest, 'hi from guest');
    const chatOk = await waitFor(async () => (await hasChat(host, 'hi from guest')) && (await hasChat(guest, 'hi from host')), 3000);
    report('1.4 chat both ways', chatOk);
    await userPlay(host);
    await waitFor(() => playing(guest), 3000); await sleep(1000);
    await userSeek(guest, (await ms(guest)) + 10000);
    const driftOk = await waitFor(async () => Math.abs((await ms(host)) - (await ms(guest))) < 1500, 4000);
    report('1.5 guest seek +10s -> host follows', driftOk, `host=${Math.round(await ms(host))} guest=${Math.round(await ms(guest))}`);
  } finally { await host.close(); await guest.close(); }
}

async function threeParty(browser) {
  const host = await newPage(browser), g1 = await newPage(browser), g2 = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    const a = await joinGuest(g1, 'Ann', code), b = await joinGuest(g2, 'Bob', code);
    report('2.0 both guests connect', a && b, `g1=${a} g2=${b}`);
    if (!a || !b) return;
    await sendChat(g1, 'relay me');
    report('2.1 guest1 chat reaches host and guest2', await waitFor(async () => (await hasChat(host, 'relay me')) && (await hasChat(g2, 'relay me')), 3000));
    await userPlay(host);
    report('2.2 host play -> both guests playing', await waitFor(async () => (await playing(g1)) && (await playing(g2)), 2500), `g1=${await playing(g1)} g2=${await playing(g2)}`);
    await userSeek(g2, 500000);
    const f = await waitFor(async () => { const t = [await ms(host), await ms(g1), await ms(g2)]; return t.every((x) => x > 495000 && Math.abs(x - t[2]) < 2000); }, 3500);
    report('2.3 guest2 seek -> host and guest1 follow', f, `host=${Math.round(await ms(host))} g1=${Math.round(await ms(g1))} g2=${Math.round(await ms(g2))}`);
  } finally { await host.close(); await g1.close(); await g2.close(); }
}

async function hostReload(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('3.0 connect', false);
    await host.reload();
    await host.waitForFunction(() => window.HWP && HWP.net, null, { timeout: 10000 });
    const back = await waitFor(async () => (await connected(guest)) && (await connected(host)), 20000);
    report('3.1 guest reconnects after host reload', back, `guest=${await connected(guest)} host=${await connected(host)}`);
    if (!back) return;
    await sleep(500);
    await userPlay(host);
    report('3.2 host play after reload -> guest follows', await waitFor(() => playing(guest), 3000), `guestPlaying=${await playing(guest)}`);
  } finally { await host.close(); await guest.close(); }
}

async function roomWaits(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('4.0 connect', false);
    await userPlay(host);
    await waitFor(() => playing(guest), 3000); await sleep(1000);
    await guest.evaluate(() => window.__fakeAd(true, 30000));
    const paused = await waitFor(async () => !(await playing(host)), 2500);
    const names = await waitFor(async () => (await waitingNames(host)).includes('Pal'), 2500);
    report('4.1 guest ad -> host pauses within 2.5s', paused, `hostPlaying=${await playing(host)}`);
    report('4.2 host sync:waiting names the guest', names, `names=${JSON.stringify(await waitingNames(host))}`);
    const m0 = await ms(host); await sleep(2000); const m1 = await ms(host);
    report('4.3 host playhead holds during wait', Math.abs(m1 - m0) <= 1000, `delta=${Math.round(m1 - m0)}`);
    await guest.evaluate(() => window.__fakeAd(false));
    const resumed = await waitFor(async () => (await playing(host)) && (await playing(guest)) && Math.abs((await ms(host)) - (await ms(guest))) < 1500, 4000);
    report('4.4 ad ends -> both playing, ms within 1500', resumed, `host=${Math.round(await ms(host))} guest=${Math.round(await ms(guest))} hp=${await playing(host)} gp=${await playing(guest)}`);
  } finally { await host.close(); await guest.close(); }
}

async function reactions(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('5.0 connect', false);
    await host.evaluate(() => HWP.net.send({ type: 'reaction', emoji: '\u{1F37F}' }));
    const ok = await waitFor(() => guest.evaluate(() => [...document.querySelectorAll('#hwp-floats .hwp-float')].some((e) => e.textContent.includes('\u{1F37F}'))), 2000);
    report('5.1 reaction floats on guest', ok);
  } finally { await host.close(); await guest.close(); }
}

let browser;
const started = Date.now();
try {
  await new Promise((r) => srv.listen(4747, r));
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  await scenario('1 two-party', () => twoParty(browser));
  await scenario('2 three-party', () => threeParty(browser));
  await scenario('3 host reload', () => hostReload(browser));
  await scenario('4 room waits', () => roomWaits(browser));
  await scenario('5 reactions', () => reactions(browser));
} finally {
  if (browser) await browser.close();
  srv.close();
}
console.log(`\n${fails ? 'FAILED' : 'ALL PASSED'} (${fails} failing, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
process.exit(fails ? 1 : 0);
