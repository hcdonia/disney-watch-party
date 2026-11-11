#!/bin/bash
# Watch Party one-line installer / updater (Mac). Paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/hcdonia/disney-watch-party/main/install.sh | bash
# Finds every copy of the extension on this Mac (Spotlight, else a scan of the home folder), replaces its files with the latest from GitHub, then restarts Chrome (chrome://restart reopens the tabs) so the new version is live.
# Not installed yet: puts it in ~/Watch Party and opens chrome://extensions for the one-time Load unpacked.
# Test knobs: HWP_DIR=<folder> forces the target, HWP_LIST=1 only lists targets, HWP_NO_RESTART=1 skips the restart.
set -u
REPO_ZIP="https://github.com/hcdonia/disney-watch-party/archive/refs/heads/main.zip"
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo; echo "Sorry, that did not work: $1"; exit 1; }

# Every copy of the extension on this Mac, from the Spotlight index only. Reading Chrome's own profile files
# makes macOS warn "Terminal would like to access data from other apps", so this never opens them.
# A copy = a folder holding both sidepanel.js and peerjs.min.js. All copies get updated (Chrome loads one of them).
find_dirs() {
  local a b
  a="$(mdfind 'kMDItemFSName == "sidepanel.js"' 2>/dev/null | sed 's|/[^/]*$||' | sort -u)"
  b="$(mdfind 'kMDItemFSName == "peerjs.min.js"' 2>/dev/null | sed 's|/[^/]*$||' | sort -u)"
  [ -n "$a" ] && [ -n "$b" ] || return 0
  comm -12 <(echo "$a") <(echo "$b") | grep -vE '/\.Trash/|/node_modules/|^/private/|^/Volumes/|/Library/' | while IFS= read -r d; do
    grep -q 'Watch Party' "$d/manifest.json" 2>/dev/null && echo "$d"   # only folders that really are this extension
  done || true
}

# Spotlight skips some folders (developer folders, excluded drives). Backup: look through the home folder a few
# levels deep, skipping Library and hidden folders (macOS may ask once about Downloads/Documents/Desktop: Allow).
scan_home() {
  find "$HOME" -maxdepth 5 \( -name Library -o -name '.*' -o -name node_modules \) -prune -o -name sidepanel.js -print 2>/dev/null \
    | sed 's|/[^/]*$||' | sort -u | while IFS= read -r d; do
      [ -f "$d/peerjs.min.js" ] && grep -q 'Watch Party' "$d/manifest.json" 2>/dev/null && echo "$d"
    done || true
}

DIRS=()
if [ -n "${HWP_DIR:-}" ]; then DIRS=("$HWP_DIR")
else
  # A git checkout is a developer's working copy: never copy over it (git pull updates that one).
  add() { while IFS= read -r d; do [ -n "$d" ] && [ ! -d "$d/.git" ] && DIRS+=("$d"); done; }
  add < <(find_dirs)
  if [ ${#DIRS[@]} -eq 0 ]; then add < <(scan_home); fi
fi
NEW=0
if [ ${#DIRS[@]} -eq 0 ]; then DIRS=("$HOME/Watch Party"); NEW=1; fi

if [ -n "${HWP_LIST:-}" ]; then printf 'would update: %s\n' "${DIRS[@]}"; exit 0; fi

echo "Getting the latest Watch Party..."
TMP="$(mktemp -d)" || fail "could not make a temporary folder."
curl -fsSL "$REPO_ZIP" -o "$TMP/wp.zip" || fail "could not download it. Check your internet and try again."
unzip -q "$TMP/wp.zip" -d "$TMP/out" || fail "could not open the download."
SRC="$TMP/out/disney-watch-party-main"
[ -f "$SRC/manifest.json" ] || fail "the download looked wrong."
echo "(If your Mac asks whether Terminal can access a folder like Downloads or Documents, click Allow.)"
VER=$(grep -m1 '"version"' "$SRC/manifest.json" | tr -dc '0-9.')
for DIR in "${DIRS[@]}"; do
  mkdir -p "$DIR" && cp -R "$SRC/." "$DIR/" || fail "could not copy the new files into $DIR."
  echo "Updated to v$VER in: $DIR"
done

if [ "$NEW" = 1 ]; then
  echo
  echo "First time on this computer. In the Chrome tab that opens:"
  echo "  1. Turn on Developer mode (top right)"
  echo "  2. Click Load unpacked"
  echo "  3. Pick the \"Watch Party\" folder in your home folder"
  [ -z "${HWP_NO_RESTART:-}" ] && open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1
  exit 0
fi

if [ -n "${HWP_NO_RESTART:-}" ]; then echo "(Skipping the Chrome restart.)"; exit 0; fi
if pgrep -xq "Google Chrome"; then
  echo
  echo "Chrome will restart to switch on the new version. Your tabs come back by themselves."
  printf "Press Enter to restart Chrome now... "
  read -r _ < /dev/tty
  open -a "Google Chrome" "chrome://restart"
fi
echo "Done. Open your Disney+ or Prime Video tab and click the Watch Party icon."
