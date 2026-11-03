#!/bin/bash
# Watch Party one-line installer / updater (Mac). Paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/hcdonia/disney-watch-party/main/install.sh | bash
# Finds the folder Chrome already loads the extension from (any profile), replaces its files with the latest
# from GitHub, then restarts Chrome (chrome://restart reopens the tabs) so the new version is live.
# Not installed yet: puts it in ~/Watch Party and opens chrome://extensions for the one-time Load unpacked.
# Test knobs: HWP_DIR=<folder> forces the target, HWP_NO_RESTART=1 skips the Chrome restart.
set -u
REPO_ZIP="https://github.com/hcdonia/disney-watch-party/archive/refs/heads/main.zip"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT
fail() { echo; echo "Sorry, that did not work: $1"; exit 1; }

# The extension folder Chrome has loaded: an unpacked path in a profile's preferences whose manifest is ours.
find_dir() {
  local prefs p
  for prefs in "$CHROME_DIR"/*/"Secure Preferences" "$CHROME_DIR"/*/Preferences; do
    [ -f "$prefs" ] || continue
    while IFS= read -r p; do
      [ -f "$p/manifest.json" ] && grep -q 'Watch Party' "$p/manifest.json" && { echo "$p"; return 0; }
    done < <(grep -o '"path":"/[^"]*"' "$prefs" 2>/dev/null | sed 's/^"path":"//; s/"$//')
  done
  return 1
}

DIR="${HWP_DIR:-$(find_dir)}"
NEW=0
if [ -z "$DIR" ]; then DIR="$HOME/Watch Party"; NEW=1; fi

echo "Getting the latest Watch Party..."
TMP="$(mktemp -d)" || fail "could not make a temporary folder."
curl -fsSL "$REPO_ZIP" -o "$TMP/wp.zip" || fail "could not download it. Check your internet and try again."
unzip -q "$TMP/wp.zip" -d "$TMP/out" || fail "could not open the download."
SRC="$TMP/out/disney-watch-party-main"
[ -f "$SRC/manifest.json" ] || fail "the download looked wrong."
mkdir -p "$DIR" || fail "could not make the folder $DIR."
cp -R "$SRC/." "$DIR/" || fail "could not copy the new files into $DIR."
VER=$(grep -m1 '"version"' "$DIR/manifest.json" | tr -dc '0-9.')
echo "Updated to v$VER in: $DIR"

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
