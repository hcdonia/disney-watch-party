// End-to-end harness: 2-3 headless pages over the real public PeerJS server. Scenarios 1-6 use a fake
// Disney+ player (tests/test.html), 7 a fake Prime Video page (tests/test-prime.html, real <video>).
// Run: node tests/run.mjs
import { chromium } from '/Users/hunterdonia/Documents/Coding Projects/Hunter Donia Website/node_modules/playwright/index.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://localhost:4747/tests/test.html';
const PRIME_URL = 'http://localhost:4747/tests/test-prime.html';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.webm': 'video/webm', '.css': 'text/css' };
// Prime's player requests, answered in Prime's shapes (PLAN.md v4). 50s ad-free (6s jingle + 44s title),
// one 10s break after 14s of title, so the 60s test video is: jingle, title, ad, title.
const PRIME_PLAYBACK = { vodPlaylistedPlaybackUrls: { result: { playbackUrls: { fullTitleDurationMs: 50000, intraTitlePlaylist: [
  { type: 'Jingle', startMs: 0, endMs: 6000 },
  { type: 'Main', startMs: 6000, endMs: 20000 },
  { type: 'Remote', urlsInPriorityOrder: ['https://ads.example/x?adMarkerId=M1&pod=1'] },
  { type: 'Main', startMs: 20000, endMs: 50000 },
] } } } };
const PRIME_ADS = { playlist: [{ description: { duration: '00:00:06.000' } }, { description: { duration: '00:00:04.000' } }] };
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/fake-prime/')) {
    const body = /GetVodPlaybackResources/.test(req.url) ? PRIME_PLAYBACK : /getVideoAds/.test(req.url) ? PRIME_ADS : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
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

async function newPage(browser, url = URL_) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(url);
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
  if (process.env.HWP_ONLY && !name.startsWith(process.env.HWP_ONLY)) return; // e.g. HWP_ONLY=7 node tests/run.mjs
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

// Both people reach the same ad break: the second one plays into it instead of pausing, so the ads
// overlap and the room waits once (about one ad long), not twice.
async function sameBreak(browser) {
  const host = await newPage(browser), guest = await newPage(browser);
  try {
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('6.0 connect', false);
    const AD = 5000, BREAK = 691708;
    const t0 = Date.now(), logs = [];
    if (process.env.HWP_TRACE) {
      host.on('console', (m) => { if (/sync:/.test(m.text())) logs.push(`${Date.now() - t0} HOST  ${m.text()}`); });
      guest.on('console', (m) => { if (/sync:/.test(m.text())) logs.push(`${Date.now() - t0} GUEST ${m.text()}`); });
    }
    await host.evaluate(() => { window.__fakeBreakAdMs = 5000; });
    await guest.evaluate(() => { window.__fakeBreakAdMs = 5000; });
    await userSeek(host, BREAK - 2500);
    await waitFor(async () => Math.abs((await ms(guest)) - (BREAK - 2500)) < 1500, 3000);
    await userPlay(host);
    await waitFor(() => playing(guest), 3000);
    const inAd = (p) => p.evaluate(() => window.__fakeInAd());
    const hostAdAt = await waitFor(() => inAd(host), 5000) ? Date.now() : 0;
    report('6.1 host hits the break', !!hostAdAt, `hostMs=${Math.round(await ms(host))}`);
    const both = await waitFor(async () => (await inAd(host)) && (await inAd(guest)), 3000);
    report('6.2 guest plays into the same break (ads overlap)', both, `guestInAd=${await inAd(guest)} guestPlaying=${await playing(guest)} guestMs=${Math.round(await ms(guest))}`);
    const tl = {};
    const mark = (k) => { if (!tl[k]) tl[k] = Date.now() - hostAdAt; };
    const resumed = await waitFor(async () => {
      const ha = await inAd(host), ga = await inAd(guest), hp = await playing(host), gp = await playing(guest);
      if (ga) mark('guestAdStart');
      if (!ha) mark('hostAdEnd');
      if (tl.guestAdStart && !ga) mark('guestAdEnd');
      return !ha && !ga && hp && gp && Math.abs((await ms(host)) - (await ms(guest))) < 1500;
    }, AD + 5000);
    const took = Date.now() - hostAdAt;
    if (logs.length) console.log(logs.join('\n'));
    report('6.3 both resume together after ONE ad length', resumed && took < AD + 5000, `took=${took}ms (ad=${AD}) ${JSON.stringify(tl)} host=${Math.round(await ms(host))} guest=${Math.round(await ms(guest))}`);
    // GIF relay: a KLIPY url goes through, anything else is dropped.
    await host.evaluate(() => HWP.ui.command({ type: 'gif', url: 'https://static.klipy.com/abc/sm.webp', w: 220, h: 124 }));
    await host.evaluate(() => HWP.ui.command({ type: 'gif', url: 'https://evil.example/x.gif', w: 220, h: 124 }));
    const gotGif = await waitFor(() => gotMsg(guest, `(m) => m && m.type === 'gif' && m.url === 'https://static.klipy.com/abc/sm.webp'`), 3000);
    const badGif = await gotMsg(guest, `(m) => m && m.type === 'gif' && /evil/.test(m.url)`);
    const logged = await guest.evaluate(() => HWP.ui.snapshot().log.some((l) => l.kind === 'gif' && l.who === 'Hunter'));
    report('6.4 gif relays to guest and lands in its chat log', gotGif && logged && !badGif, `got=${gotGif} logged=${logged} bad=${badGif}`);
    report('6.5 no in-page pill', await host.evaluate(() => !document.getElementById('hwp-pill')));
    // Reaction on a message: guest reacts to the host's gif; the host's copy of that line gains the name.
    const mid = await guest.evaluate(() => (HWP.ui.snapshot().log.find((l) => l.kind === 'gif' && l.who === 'Hunter') || {}).mid);
    await guest.evaluate((m) => HWP.ui.command({ type: 'msg-react', mid: m, emoji: '\u{1F525}' }), mid);
    const reacted = await waitFor(() => host.evaluate((m) => { const l = HWP.ui.snapshot().log.find((x) => x.mid === m); return !!(l && l.reacts && l.reacts['\u{1F525}'] && l.reacts['\u{1F525}'].includes('Pal')); }, mid), 3000);
    await guest.evaluate((m) => HWP.ui.command({ type: 'msg-react', mid: m, emoji: '\u{1F525}' }), mid); // toggle off
    const cleared = await waitFor(() => host.evaluate((m) => { const l = HWP.ui.snapshot().log.find((x) => x.mid === m); return !!l && !l.reacts; }, mid), 3000);
    report('6.6 emoji reaction on a message relays and toggles off', !!mid && reacted && cleared, `mid=${mid} reacted=${reacted} cleared=${cleared}`);
  } finally { await host.close(); await guest.close(); }
}

// ---------- Prime Video ----------
const primePage = (browser, q = '') => newPage(browser, PRIME_URL + q);
const pMs = (p) => p.evaluate(() => HWP.player.ms());
const pLast = (p) => p.evaluate(() => HWP.player.last);
const pV = (p) => p.evaluate(() => window.__v());
const pSetV = (p, t) => p.evaluate((t) => window.__setV(t), t);
const pPlaying = (p) => p.evaluate(() => !document.getElementById('v').paused);
const pPlay = (p) => p.evaluate(() => document.getElementById('v').play());
const pPause = (p) => p.evaluate(() => document.getElementById('v').pause());
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
// Let the video settle at t (a seek lands, a report arrives) before reading program ms.
async function pAt(p, t) { await pSetV(p, t); await waitFor(async () => near(await pV(p), t, 0.3) && near((await pLast(p) || {}).v, t, 0.6), 3000); await sleep(300); }

async function primeTimeline(browser) {
  const p = await primePage(browser);
  try {
    await waitFor(async () => { const l = await pLast(p); return l && l.title === 'GTI1' && l.durMs === 44000; }, 5000);
    const l0 = await pLast(p);
    report('7.1 reads the title id, length without ads, break', !!l0 && l0.title === 'GTI1' && l0.durMs === 44000 && JSON.stringify(l0.breaks) === '[14000]', JSON.stringify(l0 && { title: l0.title, durMs: l0.durMs, breaks: l0.breaks }));
    await pAt(p, 12);
    const before = await pMs(p);
    await pAt(p, 40);
    const after = await pMs(p);
    report('7.2 video time -> program time skips the jingle and the ad', near(before, 6000, 300) && near(after, 24000, 300), `v12=${before} v40=${after} (want 6000, 24000)`);
    await pAt(p, 25);
    const l1 = await pLast(p);
    report('7.3 inside the ad: ad flagged, position frozen at the break, time left', l1.ad && near(l1.ms, 14000, 300) && near(l1.adLeftMs, 5000, 600), `ad=${l1.ad} ms=${l1.ms} left=${l1.adLeftMs}`);
    // Near the end of an episode Prime prefetches the next one: the playing title must not switch.
    await p.evaluate(() => fetch('/fake-prime/playback/prs/GetVodPlaybackResources?titleId=GTI9'));
    await sleep(800);
    const l2 = await pLast(p);
    report('7.3b next-episode prefetch does not take over the playing title', l2.title === 'GTI1', `title=${l2.title}`);
    await p.evaluate(() => HWP.player.seek(30000));
    await waitFor(async () => near(await pV(p), 46, 0.3), 3000);
    report('7.4 seek to program 30s lands at video 46s (jingle + ad added back)', near(await pV(p), 46, 0.3), `v=${(await pV(p)).toFixed(2)}`);
    // Just past a break (where the room sits right after an ad): must land after the ad, never back inside it.
    await p.evaluate(() => HWP.player.seek(15000));
    await waitFor(async () => near(await pV(p), 31, 0.3) && !(await pLast(p)).ad, 3000); // the fake ad timer hides within 200ms
    const l3 = await pLast(p);
    report('7.4b seek to 1s past the break lands after the ad (video 31s), not in it', near(await pV(p), 31, 0.3) && !l3.ad, `v=${(await pV(p)).toFixed(2)} ad=${l3.ad}`);
    await p.evaluate(() => HWP.player.seek(13000));
    await waitFor(async () => near(await pV(p), 19, 0.3), 3000);
    report('7.4c seek to 1s before the break lands before the ad (video 19s)', near(await pV(p), 19, 0.3), `v=${(await pV(p)).toFixed(2)}`);
  } finally { await p.close(); }
}

async function primeFallback(browser) {
  const p = await primePage(browser, '?noplaylist=1');
  try {
    await waitFor(async () => !!(await pLast(p)), 5000);
    await pAt(p, 10);
    await p.evaluate(() => window.__primeSession(4)); // Prime says: program 4s at video 10s
    await sleep(400);
    const a = await pMs(p);
    await pAt(p, 15);
    const b = await pMs(p);
    report('7.5 no playlist seen: the UpdateSession anchor calibrates', near(a, 4000, 300) && near(b, 9000, 300), `v10=${a} v15=${b} (want 4000, 9000)`);
    // An ad the playlist never told us about: the on-screen timer freezes the position, and it stays right after.
    await p.evaluate(() => window.__screenAd(true, '0:05'));
    await pPlay(p);
    await sleep(2500);
    const l = await pLast(p);
    await p.evaluate(() => window.__screenAd(false));
    await pPause(p);
    await sleep(400);
    const vEnd = await pV(p), after = await pMs(p);
    report('7.6 on-screen-only ad: flagged, frozen, then position excludes it', l.ad && near(l.ms, 9000, 400) && near(after, 9000, 500) && vEnd > 16.5, `ad=${l.ad} during=${l.ms} after=${after} v=${vEnd.toFixed(2)} left=${l.adLeftMs}`);
  } finally { await p.close(); }
}

async function primeParty(browser) {
  const host = await primePage(browser), guest = await primePage(browser);
  try {
    await waitFor(async () => (await pLast(host) || {}).title === 'GTI1' && (await pLast(guest) || {}).title === 'GTI1', 5000);
    const code = await startHost(host, 'Hunter');
    const ok = await joinGuest(guest, 'Pal', code);
    report('7.7 prime connect', ok, `code=${code}`);
    if (!ok) return;
    await pAt(host, 8);
    await pPlay(host);
    report('7.8 prime host play -> guest playing', await waitFor(() => pPlaying(guest), 3000), `guest=${await pPlaying(guest)}`);
    await pSetV(host, 40); // the host scrubs past the ad: program 24s
    const seekOk = await waitFor(async () => near(await pMs(guest), await pMs(host), 1500) && (await pMs(guest)) > 23000, 4000);
    report('7.9 prime host seek -> guest at the same program time', seekOk, `host=${await pMs(host)} guest=${await pMs(guest)} guestV=${(await pV(guest)).toFixed(2)}`);
    await pPause(guest);
    report('7.10 prime guest pause -> host pauses', await waitFor(async () => !(await pPlaying(host)), 3000), `host=${await pPlaying(host)}`);
    // Both run into the ad break together: the room waits once and resumes in step.
    await pSetV(host, 17); // program 11s, 3s before the break
    await waitFor(async () => near(await pMs(guest), 11000, 1500), 4000);
    await pPlay(host);
    const bothAd = await waitFor(async () => (await pLast(host)).ad && (await pLast(guest)).ad, 7000);
    report('7.11 prime: both reach the ad break', bothAd, `hostAd=${(await pLast(host)).ad} guestAd=${(await pLast(guest)).ad}`);
    const resumed = await waitFor(async () => {
      const h = await pLast(host), g = await pLast(guest);
      return !h.ad && !g.ad && (await pPlaying(host)) && (await pPlaying(guest)) && near(h.ms, g.ms, 1500) && h.ms > 14000;
    }, 16000);
    report('7.12 prime: after the ad both play on together', resumed, `host=${await pMs(host)} guest=${await pMs(guest)} hp=${await pPlaying(host)} gp=${await pPlaying(guest)}`);
  } finally { await host.close(); await guest.close(); }
}

// A guest on a different episode (Prime can't follow by URL) is left alone.
async function primeOtherEpisode(browser) {
  const host = await primePage(browser), guest = await primePage(browser, '?gti=GTI2');
  try {
    await waitFor(async () => (await pLast(host) || {}).title === 'GTI1' && (await pLast(guest) || {}).title === 'GTI2', 5000);
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('7.13 connect', false);
    await pAt(guest, 10);
    await pAt(host, 45);
    await sleep(5000); // past a host tick
    report('7.13 prime: a guest on another episode is not seeked', near(await pV(guest), 10, 0.5), `guestV=${(await pV(guest)).toFixed(2)}`);
  } finally { await host.close(); await guest.close(); }
}

// The ad-loop case: a guest already past the break must not be sent back to just before it (that replays the ad).
async function primeNoRewatch(browser) {
  const host = await primePage(browser), guest = await primePage(browser);
  try {
    await waitFor(async () => (await pLast(host) || {}).title === 'GTI1' && (await pLast(guest) || {}).title === 'GTI1', 5000);
    // Positions first (a catch-up, not a person seeking): seeks made in a party are deliberate and honored.
    await pAt(guest, 33);           // guest: program 17s, the break (14s) and its ad already behind
    await pAt(host, 17);            // host: program 11s, 3s before the break
    const code = await startHost(host, 'Hunter');
    if (!(await joinGuest(guest, 'Pal', code))) return report('7.14 connect', false);
    await sleep(1500);
    await guest.evaluate(() => { window.__guestAds = 0; HWP.bus.on('sync:ad', (e) => { if (e.who === 'me' && e.on) window.__guestAds++; }); });
    await pPlay(host);
    await sleep(9000);              // host ticks arrive, host plays into its own ad
    const gAds = await guest.evaluate(() => window.__guestAds), gV = await pV(guest);
    report('7.14 prime: guest past the break is held, never rewound into the ad', gAds === 0 && gV >= 29.5, `guestAds=${gAds} guestV=${gV.toFixed(2)}`);
    const together = await waitFor(async () => {
      const h = await pLast(host), g = await pLast(guest);
      return !h.ad && (await pPlaying(host)) && (await pPlaying(guest)) && near(h.ms, g.ms, 1500) && h.ms > 14000;
    }, 16000);
    report('7.15 prime: after the host\'s ad both play on together', together && (await guest.evaluate(() => window.__guestAds)) === 0, `host=${await pMs(host)} guest=${await pMs(guest)}`);
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
  await scenario('6 same break', () => sameBreak(browser));
  await scenario('7a prime timeline', () => primeTimeline(browser));
  await scenario('7b prime fallback', () => primeFallback(browser));
  await scenario('7c prime party', () => primeParty(browser));
  await scenario('7d prime other episode', () => primeOtherEpisode(browser));
  await scenario('7e prime no rewatch', () => primeNoRewatch(browser));
} finally {
  if (browser) await browser.close();
  srv.close();
}
console.log(`\n${fails ? 'FAILED' : 'ALL PASSED'} (${fails} failing, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
process.exit(fails ? 1 : 0);
