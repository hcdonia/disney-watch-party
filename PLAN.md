# Disney Watch Party: v2 build plan (2026-10-09, FOREMAN MODE)

Goal: make the extension genuinely good in one focused hour. v1 (commit 711b6d1) works for two people: P2P sync + chat sidebar. v2 adds reliability, more people, ad handling, names, reactions, polish, tests.

## Architecture (v2)

Manifest V3 content script on `*://*.disneyplus.com/*`, loaded in this order (all share `window.HWP`):

```
peerjs.min.js  src/state.js  src/net.js  src/sync.js  src/ui.js  src/main.js
```

`src/state.js` (DONE, foreman): `HWP.state`, `HWP.bus.on/off/emit`, `HWP.log`.
`src/main.js` (DONE, foreman): `HWP.session.save/clear/load`, then `HWP.ui.init()`, `HWP.sync.start()`, session restore.

### Contract between modules

**Messages** are plain objects. `HWP.net.send(msg)` stamps `from` (sender name) and `sentAt` (Date.now()) on every outgoing message. Host relays every guest message to the other guests (so everyone sees everything), except it never echoes a message back to its sender.

| type | fields | sent by |
|---|---|---|
| `hello` | `name` | guest, on open |
| `welcome` | `names: string[]` (everyone in room incl. host), `controlMode` | host, reply to hello |
| `roster` | `names: string[]` | host, whenever someone joins/leaves |
| `control` | `mode: 'everyone'\|'host'` | host |
| `play` / `pause` / `seek` | `time`, `paused`, `url` | sync.js |
| `sync` / `tick` | `time`, `paused`, `url`, `rate` | host's sync.js (tick every 4s) |
| `ad` | `on: boolean` | sync.js, when local ad state changes |
| `chat` | `text` (≤500 chars) | ui.js |
| `reaction` | `emoji` | ui.js |

**Bus events**

| event | payload | emitted by |
|---|---|---|
| `net:status` | `{ state: 'idle'\|'hosting'\|'joining'\|'connected'\|'reconnecting'\|'error', message?, code?, peerCount }` | net.js |
| `net:message` | `(msg, fromPeerId)` for every received message (after relay handling) | net.js |
| `net:roster` | `{ names: string[] }` (others in room, not self) | net.js |
| `sync:event` | `{ kind: 'play'\|'pause'\|'seek', by: name, time }` for REMOTE actions applied locally | sync.js |
| `sync:ad` | `{ on: boolean, who: 'me'\|name }` | sync.js |
| `ui:layout` | `{ open: boolean }` | ui.js |

**Module APIs**

- `HWP.net = { host(code), join(code), leave(), send(msg), isConnected(), peerCount() }`
- `HWP.sync = { start(), stop(), video() /* current <video> or null */, fmt(seconds) /* "1:02:33" */ }`
- `HWP.ui = { init() }`

`HWP.state.name` is set by ui.js (prompt once, persisted in localStorage `hwp-name`). `HWP.state.role/code` are set by net.js on host/join and cleared on leave; net.js calls `HWP.session.save()` / `HWP.session.clear()`.

## Lanes (parallel, no file overlap)

| lane | owner | files | model |
|---|---|---|---|
| A net | worker | `src/net.js` | opus |
| B sync | worker | `src/sync.js` | opus |
| C ui | worker | `src/ui.js`, `panel.css` | opus |
| D assets+tests | worker | `icon.png`, `icon.svg`, `popup.html`, `popup.js`, `manifest.json`, `README.md`, `tests/*` | sonnet |
| foreman | me | `src/state.js`, `src/main.js`, `PLAN.md`, integration, final test run, git ship | |

## Feature list

- [x] A1 Host accepts many guests (fan-out + relay). Room code = PeerJS id `hunty-watch-party-<CODE>`.
- [x] A2 Guest auto-reconnects every 3s when the host link drops (host reloaded) up to 2 min; status `reconnecting`.
- [x] A3 Host re-claims its id after reload (sessionStorage restore in main.js already re-calls host(code)); on `unavailable-id` retry 5x with 2s gaps before erroring.
- [x] A4 Names: hello/welcome/roster protocol; `net:roster`.
- [x] B1 Pick the real player (visible + readyState>0 + largest), never the dummy `<video>`.
- [x] B2 Latency compensation: when applying a remote time while playing, add `(Date.now() - sentAt)/1000`.
- [x] B3 Ad guard: detect ads; while local ad is on, ignore remote play/pause/seek and do not send; when ad ends, guest requests `sync` from host (send `{type:'sync-request'}` → host replies `sync`). Detection heuristics: elements whose text matches `/^Ad\b|Ad \d+ of \d+|Advertisement/i`, `[class*="ad-"]`, `[data-testid*="ad"]`, AND a seek that doesn't take (set currentTime, re-read after 400ms, off by >2s) ⇒ adMode for 8s.
- [x] B4 Control mode: guests only send play/pause/seek when `controlMode==='everyone'`. In `host` mode a guest's local pause gets reverted to the host state on next tick (already the drift logic).
- [x] B5 Follow host to the same title (`url` on sync/tick): only when host is on `/play/` or `/video/`; never loop (don't navigate twice to the same url within 10s).
- [x] B6 `sync:event` with who did it, for system lines in chat.
- [x] C1 Sidebar 320px right column; page pushed left via injected `<style id="hwp-layout">` (selectors proven live: `html, body, #root, #dplus-app-element, [class*="video_view"], [class*="hudson-contain"], [class*="player-container-root"], .mini-player-bounds, draggable-surface, .mini-player-inner, .btm-media-player, .btm-media-clients, .media-element-container, video.hive-video { width: calc(100vw - 320px) !important; max-width: ... }` + dispatch `resize`). Removed when collapsed or fullscreen.
- [x] C2 Name prompt (inline input, not window.prompt) before first host/join; persisted.
- [x] C3 Copy code button, "Start a party" / "Join" flow, status line, people list, leave.
- [x] C4 Chat: own vs others, name labels, timestamps (h:mm), system lines for play/pause/seek/join/leave/ad, unread badge on collapsed tab, autoscroll unless scrolled up, Enter sends, keys never leak to the player.
- [x] C5 Reactions row (😂 ❤️ 😭 🔥 👀 🍿) → floats up over the video briefly on everyone's screen.
- [x] C6 Host-only toggle "Anyone can control" (host sees it; sends `control`).
- [x] C7 Dark Disney-ish look, respects reduced motion, no layout jank.
- [x] D1 Real icon (popcorn, SVG → PNG 16/48/128 via playwright screenshot or python). No Disney trademarks.
- [x] D2 `popup.html` (action popup): how to use, version, link to disneyplus.com.
- [x] D3 manifest: name, version 2.0.0, js list above, css, action popup, icons.
- [x] D4 tests/run.mjs: local http server w/ range support, test page with dummy + real video, scenarios: 2-party sync; 3-party chat relay + sync; host reload → guest reconnects; ad guard (page overrides currentTime setter to refuse) → no sync fight, resync after; reaction broadcast. Prints PASS/FAIL per scenario, exit 1 on any FAIL.
- [x] D5 README rewrite.

## Status log
- 2026-10-09 22:20 plan written, workers spawned.
- 2026-10-09 23:05 all four lanes landed. Foreman fixes in sync.js: (1) attach grace was blocking every local event for 3s on both sides; now guests only, 1.5s, play/seek only, lifted after a real click/keypress; (2) blanket 800ms "ignore my own events" window replaced with exact expected-event counting so a real pause right after a remote seek still goes out. tests/run.mjs: ALL 15 PASS. content.js (v1) removed.
- Untested on the real site: ad detection against Disney+'s actual ad UI (refused-seek fallback is the safety net), autoplay block after follow-host reload.
