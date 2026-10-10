// End-to-end harness: two/three headless pages talk over real PeerJS. Run: node tests/run.mjs
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

const vid = (p) => p.evaluate(() => { const v = document.querySelector('#v'); return { t: v.currentTime, paused: v.paused }; });
const time = async (p) => (await vid(p)).t;
const paused = async (p) => (await vid(p)).paused;
const body = (p) => p.textContent('.hwp-body').catch(() => '');
const chat = (p) => p.textContent('#hwp-chat').catch(() => '');
const connected = async (p) => (await body(p)).includes('Connected');

async function newPage(browser) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(URL_);
  await p.waitForSelector('#hwp-panel', { timeout: 10000 });
  return p;
}
async function startHost(p, name) {
  await p.fill('#hwp-name', name); await p.click('#hwp-host');
  await waitFor(async () => /\S/.test((await p.textContent('.hwp-code').catch(() => '')) || ''), 10000);
  return ((await p.textContent('.hwp-code')) || '').trim();
}
async function joinGuest(p, name, code) {
  await p.fill('#hwp-name', name); await p.fill('#hwp-code', code); await p.click('#hwp-join');
  return waitFor(() => connected(p), 30000);
}
async function sendChat(p, text) { await p.fill('#hwp-msg', text); await p.press('#hwp-msg', 'Enter'); }

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
    await host.evaluate(() => document.querySelector('#v').play());
    report('1.1 host play -> guest playing', await waitFor(async () => !(await paused(guest)), 2000), `guestPaused=${await paused(guest)}`);
    await host.evaluate(() => { document.querySelector('#v').currentTime = 30; });
    const seekOk = await waitFor(async () => Math.abs((await time(host)) - (await time(guest))) < 1.5 && (await time(guest)) > 25, 1500);
    report('1.2 host seek 30 -> guest within 1.5s', seekOk, `host=${(await time(host)).toFixed(1)} guest=${(await time(guest)).toFixed(1)}`);
    await guest.evaluate(() => document.querySelector('#v').pause());
    report('1.3 guest pause -> host paused', await waitFor(() => paused(host), 2000), `hostPaused=${await paused(host)}`);
    await sendChat(host, 'hi from host'); await sendChat(guest, 'hi from guest');
    const chatOk = await waitFor(async () => { const h = await chat(host), g = await chat(guest); return h.includes('hi from guest') && h.includes('hi from host') && g.includes('hi from host') && g.includes('hi from guest'); }, 3000);
    report('1.4 chat both ways', chatOk);
    await host.evaluate(() => document.querySelector('#v').play());
    await waitFor(async () => !(await paused(guest)), 3000); await sleep(1000);
    await guest.evaluate(() => { const v = document.querySelector('#v'); v.currentTime = v.currentTime + 10; });
    const driftOk = await waitFor(async () => Math.abs((await time(host)) - (await time(guest))) < 1.5, 6000);
    report('1.5 drift +10s corrected within 6s', driftOk, `gap=${Math.abs((await time(host)) - (await time(guest))).toFixed(1)}`);
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
    report('2.1 guest1 chat reaches host and guest2', await waitFor(async () => (await chat(host)).includes('relay me') && (await chat(g2)).includes('relay me'), 3000));
    await host.evaluate(() => document.querySelector('#v').play());
    report('2.2 host play -> both guests playing', await waitFor(async () => !(await paused(g1)) && !(await paused(g2)), 2500), `g1Paused=${await paused(g1)} g2Paused=${await paused(g2)}`);
    await g2.evaluate(() => { document.querySelector('#v').currentTime = 50; });
    const f = await waitFor(async () => { const t = [await time(host), await time(g1), await time(g2)]; return t.every((x) => x > 45 && Math.abs(x - t[2]) < 2); }, 3500);
    report('2.3 guest2 seek -> host and guest1 follow', f, `host=${(await time(host)).toFixed(1)} g1=${(await time(g1)).toFixed(1)} g2=${(await time(g2)).toFixed(1)}`);
  } finally { await host.close(); await g1.close(); await g2.close(); }
}

async function hostReload(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('3.0 connect', false);
    await host.reload();
    const back = await waitFor(async () => (await connected(guest)) && (await connected(host)), 20000);
    report('3.1 guest reconnects after host reload', back, `guest="${(await body(guest)).replace(/\s+/g, ' ').slice(0, 60)}"`);
    if (!back) return;
    await sleep(500);
    await host.evaluate(() => document.querySelector('#v').play());
    report('3.2 host play after reload -> guest follows', await waitFor(async () => !(await paused(guest)), 3000), `guestPaused=${await paused(guest)}`);
  } finally { await host.close(); await guest.close(); }
}

async function adGuard(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('4.0 connect', false);
    await host.evaluate(() => document.querySelector('#v').play());
    await waitFor(async () => !(await paused(guest)), 3000);
    await guest.evaluate(() => { document.querySelector('#adflag').hidden = false; });
    await sleep(1200);
    const before = await time(guest);
    await host.evaluate(() => { document.querySelector('#v').currentTime = 40; });
    await sleep(2000);
    const during = await time(guest);
    report('4.1 guest ignores host seek during ad', during < 20 && Math.abs(during - before) < 6, `before=${before.toFixed(1)} during=${during.toFixed(1)}`);
    await guest.evaluate(() => { document.querySelector('#adflag').hidden = true; });
    const ok = await waitFor(async () => Math.abs((await time(host)) - (await time(guest))) < 1.5, 8000);
    report('4.2 guest resyncs after ad ends', ok, `host=${(await time(host)).toFixed(1)} guest=${(await time(guest)).toFixed(1)}`);
  } finally { await host.close(); await guest.close(); }
}

async function reactions(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('5.0 connect', false);
    await host.click('#hwp-reactions [data-emoji="🍿"]');
    const ok = await waitFor(() => guest.evaluate(() => [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && el.textContent.includes('🍿') && !el.closest('#hwp-reactions') && !el.closest('#hwp-chat'))), 2000);
    report('5.1 reaction floats on guest outside reactions row', ok);
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
  await scenario('4 ad guard', () => adGuard(browser));
  await scenario('5 reactions', () => reactions(browser));
} finally {
  if (browser) await browser.close();
  srv.close();
}
console.log(`\n${fails ? 'FAILED' : 'ALL PASSED'} (${fails} failing, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
process.exit(fails ? 1 : 0);
