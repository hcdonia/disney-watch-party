# Watch Party (Hunty) (v3.2)

A free Chrome extension that keeps Disney+ or Amazon Prime Video in sync between two or more people in different places. Play, pause and seek happen for everyone, and there is a chat sidebar with emoji reactions. No account, no server of ours.

## Install (do this on every computer)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. After updating the files, click the refresh arrow on the extension card and reload your Disney+ or Prime Video tab.

## Updating

1. In this folder, double-click `update.command` (Mac) or `update.bat` (Windows).
2. When it finishes, click the refresh arrow on the extension card at `chrome://extensions`, then reload your Disney+ or Prime Video tab.

The side panel tells you when an update is out.

## Use

1. Open Disney+ or Prime Video (primevideo.com or amazon.com/gp/video) and start the show or movie. Everyone should be on the same title, on the same site.
   - On Prime Video everyone opens the same episode themselves: Prime plays every episode from one page, so the party can't move you to the host's episode the way it does on Disney+.
2. Click the Watch Party icon in the toolbar to open the side panel. Type your name.
3. One person clicks **Start a party** and shares the 4-letter code.
4. Everyone else types the code and clicks **Join**. The panel shows "Connected" when you are linked.
5. Play, pause or seek and everyone follows. Chat in the panel, send GIFs (the GIF button), react to a message (hover it, tap the smiley), or tap an emoji reaction (😂 ❤️ 😭 🔥 👀 🍿) to float it over everyone's video.
6. The host can switch "Anyone can control" off so only the host's play, pause and seek count.

## Ads

On the ad-supported plans (Disney+ and Prime Video), ad breaks sit at fixed spots in the show. When one person's ad starts, anyone right behind the same break keeps playing into it so their ad runs at the same time, and the room waits once (for the longest ad) instead of once per person. Anyone further away pauses and waits. When the last ad ends, everyone resumes together at the same spot.

## GIFs

GIF search uses KLIPY (Tenor's API shut down in June 2026). Make a free app key at https://partner.klipy.com (API Keys) and put it in `config.js` (`klipyKey`). A testing key allows 100 searches an hour; ask KLIPY for production access in the same panel to lift that. With no key the GIF button says so and everything else still works.

## Troubleshooting

- **Code not found:** the host has not started the party yet, or the code was typed wrong.
- **Stuck on "reconnecting":** the host closed the tab. It retries for a couple of minutes; it recovers as soon as the host reopens the site (a host reload restores the party on its own).
- **Nothing syncs:** reload the Disney+ / Prime Video tab on both sides and make sure everyone is on the same title (and the same episode).
- **Prime Video is a few seconds off after a reload:** press play or pause once. Prime reports its real position on every play/pause, and the extension lines up from that.

## Privacy

Video and chat go directly between your browsers (peer-to-peer). The only outside service is PeerJS's free public signaling server, which sees the room id used to introduce the browsers. Nothing is recorded, nothing is stored, and no Disney+ or Amazon login details are touched. The extension asks for no extra permissions.

## Files

- `manifest.json`: extension setup (Manifest V3).
- `peerjs.min.js`: PeerJS library (peer-to-peer connections).
- `src/state.js`: shared state and event bus.
- `src/net.js`: connections, rooms, names, relay.
- `src/sync.js`: player control, drift fixes, ad handling.
- `src/player.js`, `src/bridge.js` (Disney+), `src/bridge-prime.js` (Prime Video): read each site's player and control it.
- `src/ui.js`: side panel, chat, reactions.
- `src/main.js`: startup and session restore.
- `panel.css`: styles for the reaction floats over the video.
- `sidepanel.html/js/css`, `config.js`: the side panel (party, chat, GIFs, reactions) and its KLIPY key.
- `icon.svg`, `icon16.png`, `icon48.png`, `icon128.png`: icons.
- `tests/run.mjs`, `tests/test.html`, `tests/test.mp4`: end-to-end tests (`node tests/run.mjs`).

## v3 notes (2026-10-10)
- Sync runs on Disney+'s own player clock (program position in ms) through the page's player API, not the raw video element. Skips land anywhere in the title, not just inside the buffer.
- Chat lives in Chrome's side panel: click the toolbar icon. Nothing sits on the video except reaction floats.
- Ads: when anyone hits an ad, everyone else pauses and the panel shows who the room is waiting on. When the last ad ends, everyone resumes together at the same spot.

## v3.1 notes (2026-10-14)
- Same-break ads overlap (see Ads above) instead of playing one after another.
- In-page pill removed. GIF keyboard (KLIPY) and per-message emoji reactions in the side panel.
- Fixed: the host could fail to resume after a wait because it trusted a 250ms-old "playing" sample.

## v3.2 notes (2026-11-02)
- Amazon Prime Video support (primevideo.com, amazon.com/gp/video, amazon.com Prime Video title pages). One extension for both sites.
- Prime's video clock includes a short intro jingle and every ad, so the extension works out the real show position from Prime's own playlist and ad lengths, and corrects itself from the position Prime reports on each play/pause. Ads, room waits and "same break" ad overlap work as on Disney+.
- A guest on a different Prime episode is left alone instead of being seeked around.
- Extension renamed to "Watch Party (Hunty)".
