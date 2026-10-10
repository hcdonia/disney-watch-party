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

# v3: player-native sync + side panel (2026-10-09 23:50, FOREMAN MODE)

## Facts measured live on disneyplus.com (Agatha All Along, ads plan)

- The page has a `<disney-web-player>` element whose main-world instance property `mediaPlayer` (same object as `document.querySelector('disney-web-player-ui').mediaPlayerApi`) is the real player API. Content scripts live in an isolated world and cannot see it; a `<script src=chrome.runtime.getURL(...)>` injected into the page can (needs `web_accessible_resources`).
- `mediaPlayer.timeline.info.playheadPositionMs` = program position (ms). `programDurationMs` = title length (2523792 for a 42-min episode). `type: "VOD"`.
- `video.currentTime` / `video.duration` on the `<video>` are NOT program time: duration is the buffered edge (grows 28 → 36 → 44...), currentTime resets on reloads/ads. Never sync on them again. Setting `video.currentTime` past the buffer clamps to the buffered edge (asked 600, landed 35).
- `mediaPlayer.seek(ms)`: number, MILLISECONDS. Seeking across an unseen ad break queues the seek: the ad plays first (store shows milestone `ad-queued-seek-marker`), then it lands.
- `mediaPlayer.play()` / `mediaPlayer.pause()` work; `mediaPlayer.playbackStatus.currentState` is PLAYING / PAUSED / SEEKING / BUFFERING...
- Ads: `stateStore.getState().ui.milestones.data` lists breaks: `{milestoneType:'ad-video', milestoneTime: ms}` (this episode: 0, 691708, 1128208, 1590167, 1802750). DURING an ad `playheadPositionMs` is FROZEN at the break's ms while `video.currentTime` keeps advancing and status stays PLAYING. The `<ad-badge-overlay>` element has main-world props `overlayVisible` (boolean) and `localState.adBadge` (badge state; the on-screen badge reads "Ad 0:30 Learn More"); its text is in a nested shadow root. Ads are not DRM-protected (they show in screenshots); the show is black in captures.
- `mediaPlayer.on(name, fn)` exists but event names are unknown; poll instead (250ms) or subscribe to `stateStore.subscribe`.
- Layout: forcing CSS widths on the player crops the video (Disney+ positions it with JS from window.innerWidth); `transform: scale()` on the app root collapses it to height 0. The in-page sidebar approach is dead. Use Chrome's Side Panel (`sidePanel` permission), which shrinks the real viewport.
- AppleScript window id ≠ CGWindowID; `swift` + CGWindowListCopyWindowInfo gets the real one for `screencapture -l`.

## v3 architecture

Load order (manifest): `peerjs.min.js, src/state.js, src/net.js, src/player.js, src/sync.js, src/ui.js, src/main.js`. `src/bridge.js` is NOT a content script: `src/player.js` injects it into the page (web_accessible_resources). `background.js` is the MV3 service worker (side panel open + port relay). `sidepanel.html/js/css` is the chat UI.

### HWP.player (src/player.js, isolated world; src/bridge.js, main world)
- bridge.js (main world): finds `disney-web-player`; every 250ms posts `window.postMessage({hwp:'state', ms, durMs, status, playing, ad, adLeftMs, breaks:[ms...], v: videoCurrentTime}, '*')`; `ad` = badge overlayVisible OR (status PLAYING and playhead unchanged for 1.5s while video.currentTime advanced > 1s). Listens for `{hwp:'cmd', op:'seek'|'play'|'pause', ms}` and calls mediaPlayer. Re-finds the player if the element is replaced (SPA navigation).
- player.js (isolated): injects bridge, relays state to `HWP.bus.emit('player:state', s)`, keeps `HWP.player.last`, exposes `HWP.player = { ready(), ms(), playing(), ad(), seek(ms), play(), pause() }`.

### Sync (src/sync.js) — program-ms model
Messages (all carry `ms` program position, NOT `time`): `play {ms}`, `pause {ms}`, `seek {ms, playing}`, `sync`/`tick {ms, playing, ad, adLeftMs, url}`, `ad {on, leftMs}`, `sync-request`. Tolerance 1500ms. Latency comp: playing targets add (now - sentAt).
ROOM WAITS: when any member reports `ad: true`, every member NOT in an ad pauses (HWP.player.pause()) and the UI shows "Waiting for <name>'s ad". When the last ad ends, the host sends `play {ms}` and everyone resumes at the same ms. Members in an ad ignore play/pause/seek until their ad ends, then `sync-request`. Guests' local play/pause/seek respect controlMode as before. Local-event detection: compare consecutive player states (playing flipped → play/pause; ms jumped > 3000 beyond elapsed → seek) and send unless it was caused by a remote command we issued in the last 1.5s.
`sync:event {kind, by, ms}`, `sync:ad {on, who, leftMs}`, new `sync:waiting {names: string[]}` (who the room is waiting on; [] when nobody).
`HWP.sync.fmt(seconds)` kept, add `HWP.sync.fmtMs(ms)`.

### UI (src/ui.js in-page + side panel)
- In-page (ui.js): a small pill bottom-right (status dot, "Chat" button, unread badge, "Waiting for Alex's ad…" line), reaction floats over the video, nothing that overlays the video otherwise. No layout CSS injection. Clicking "Chat" → `chrome.runtime.sendMessage({type:'open-sidepanel'})`.
- background.js: `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`; on `open-sidepanel` message → `chrome.sidePanel.open({tabId: sender.tab.id})` (works since Chrome 116 when triggered by a user gesture message); relays port messages between the side panel and the content script of the active tab (`chrome.tabs.sendMessage` / `chrome.runtime.connect` named `hwp-panel`).
- sidepanel.html/js/css: the full party UI from v2 ui.js (name, start/join/copy code, people, control toggle, chat with system lines, reactions row, leave). It mirrors `HWP.state` + bus events it receives from the page (`net:status`, `net:message`, `net:roster`, `sync:event`, `sync:ad`, `sync:waiting`, `ui:unread`) and sends commands (`host`, `join`, `leave`, `chat`, `reaction`, `control`, `set-name`). Dark palette as before.
- Keep DOM ids inside the side panel the same as v2 (`#hwp-name`, `#hwp-host`, `#hwp-code`, `#hwp-join`, `#hwp-chat`, `#hwp-msg`, `#hwp-reactions [data-emoji]`, `#hwp-control`, `#hwp-leave`, `.hwp-code`, `.hwp-status`, `#hwp-people`).

### Tests (tests/)
tests/test.html gets a FAKE `<disney-web-player>` main-world shim (`tests/fake-player.js`) with `mediaPlayer` {timeline.info.playheadPositionMs advancing while playing, programDurationMs 2523792, seek(ms) with optional queued ad, play(), pause(), playbackStatus.currentState} and an `<ad-badge-overlay>` with `overlayVisible`; a test hook `window.__fakeAd(onOff, leftMs)` freezes the playhead and flips the badge. Scenarios: 2-party play/pause/seek on program ms (seek to 1,300,000 ms lands for both), 3-party relay, host reload reconnect, ROOM WAITS (guest hits ad → host pauses within 2s; ad ends → both playing within 3s at same ms ±1500), reactions float. Since the side panel can't load in the page, the harness drives `HWP.net` / `HWP.state.name` directly via page.evaluate for host/join/chat, and checks bus events through a page-side recorder (`window.__hwpEvents`).

## v3 lanes
| lane | files | model |
|---|---|---|
| E player+sync | src/bridge.js, src/player.js, src/sync.js | opus |
| F side panel | src/ui.js, panel.css, sidepanel.html, sidepanel.js, sidepanel.css, background.js, popup.html, popup.js | opus |
| G tests | tests/* | sonnet |
| foreman | manifest.json, src/main.js, PLAN.md, README.md, integration, ship | |
