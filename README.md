# Disney Watch Party (v3) (Hunty)

A free Chrome extension that keeps Disney+ in sync between two or more people in different places. Play, pause and seek happen for everyone, and there is a chat sidebar with emoji reactions. No account, no server of ours.

## Install (do this on every computer)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. After updating the files, click the refresh arrow on the extension card and reload your Disney+ tab.

## Use

1. Open Disney+ and start the show or movie. Everyone should be on the same title.
2. Click the Watch Party icon in the toolbar to open the side panel. Type your name.
3. One person clicks **Start a party** and shares the 4-letter code.
4. Everyone else types the code and clicks **Join**. The panel shows "Connected" when you are linked.
5. Play, pause or seek and everyone follows. Chat in the panel, send GIFs (the GIF button), react to a message (hover it, tap the smiley), or tap an emoji reaction (😂 ❤️ 😭 🔥 👀 🍿) to float it over everyone's video.
6. The host can switch "Anyone can control" off so only the host's play, pause and seek count.

## Ads

On the ad-supported plan, ad breaks sit at fixed spots in the show. When one person's ad starts, anyone right behind the same break keeps playing into it so their ad runs at the same time, and the room waits once (for the longest ad) instead of once per person. Anyone further away pauses and waits. When the last ad ends, everyone resumes together at the same spot.

## GIFs

GIF search uses KLIPY (Tenor's API shut down in June 2026). Make a free app key at https://partner.klipy.com (API Keys) and put it in `config.js` (`klipyKey`). A testing key allows 100 searches an hour; ask KLIPY for production access in the same panel to lift that. With no key the GIF button says so and everything else still works.

## Troubleshooting

- **Code not found:** the host has not started the party yet, or the code was typed wrong.
- **Stuck on "reconnecting":** the host closed the tab. It retries for a couple of minutes; it recovers as soon as the host reopens Disney+ (a host reload restores the party on its own).
- **Nothing syncs:** reload the Disney+ tab on both sides and make sure everyone is on the same title.

## Privacy

Video and chat go directly between your browsers (peer-to-peer). The only outside service is PeerJS's free public signaling server, which sees the room id used to introduce the browsers. Nothing is recorded, nothing is stored, and no Disney+ login details are touched. The extension asks for no extra permissions.

## Files

- `manifest.json`: extension setup (Manifest V3).
- `peerjs.min.js`: PeerJS library (peer-to-peer connections).
- `src/state.js`: shared state and event bus.
- `src/net.js`: connections, rooms, names, relay.
- `src/sync.js`: player control, drift fixes, ad handling.
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
