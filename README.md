# Disney Watch Party (Hunty)

A free Chrome extension that keeps Disney+ in sync between two or more people in different places. Play, pause and seek happen for everyone, and there is a chat sidebar with emoji reactions. No account, no server of ours.

## Install (do this on every computer)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. After updating the files, click the refresh arrow on the extension card and reload your Disney+ tab.

## Use

1. Open Disney+ and start the show or movie. Everyone should be on the same title.
2. A side panel appears on the right. Type your name.
3. One person clicks **Start a party** and shares the 4-letter code.
4. Everyone else types the code and clicks **Join**. The panel shows "Connected" when you are linked.
5. Play, pause or seek and everyone follows. Chat in the panel, and tap an emoji reaction (😂 ❤️ 😭 🔥 👀 🍿) to float it over everyone's video.
6. The host can switch "Anyone can control" off so only the host's play, pause and seek count.

## Ads

If you have the ad-supported plan, ads play at different times for different people. While an ad is on your screen the extension stops sending and ignoring commands so nobody gets yanked around. When your ad ends it asks the host where the show is and catches up.

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
- `panel.css`: side panel styling.
- `popup.html`, `popup.js`: toolbar popup.
- `icon.svg`, `icon16.png`, `icon48.png`, `icon128.png`: icons.
- `tests/run.mjs`, `tests/test.html`, `tests/test.mp4`: end-to-end tests (`node tests/run.mjs`).
