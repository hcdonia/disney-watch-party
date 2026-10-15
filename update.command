#!/bin/bash
# Disney Watch Party updater (Mac). Double-click this file.
cd "$(dirname "$0")" || exit 1
REPO_ZIP="${HWP_ZIP_URL:-https://github.com/hcdonia/disney-watch-party/archive/refs/heads/main.zip}"
DIR="$(pwd)"
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

fail() {
  echo
  echo "Sorry, the update did not work: $1"
  echo
  read -n 1 -s -r -p "Press any key to close"
  echo
  exit 1
}

echo "Updating Disney Watch Party..."
done_update=0
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  if git pull --ff-only >/dev/null 2>&1; then done_update=1; fi
fi

if [ "$done_update" = 0 ]; then
  command -v curl >/dev/null 2>&1 || fail "this computer is missing a download tool."
  TMP="$(mktemp -d)" || fail "could not make a temporary folder."
  curl -fsSL "$REPO_ZIP" -o "$TMP/dwp.zip" || fail "could not download the update. Check your internet and try again."
  unzip -q "$TMP/dwp.zip" -d "$TMP/out" || fail "could not open the downloaded update."
  [ -d "$TMP/out/disney-watch-party-main" ] || fail "the downloaded update looked wrong."
  cp -R "$TMP/out/disney-watch-party-main/." "$DIR/" || fail "could not copy the new files."
fi

VER=$(grep -m1 '"version"' manifest.json | tr -dc '0-9.')
[ -n "$VER" ] || fail "could not read the new version."
echo
echo "Updated to v$VER. Last step: in the Chrome tab that just opened, click the refresh arrow on \"Disney Watch Party\", then reload your Disney+ tab."
echo
if [ -z "$HWP_NO_OPEN" ]; then
  open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || echo "(Chrome did not open by itself. Open a new tab, type chrome://extensions and press Enter.)"
fi
echo
read -n 1 -s -r -p "Press any key to close"
echo
