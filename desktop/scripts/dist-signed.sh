#!/bin/sh
# Builds, signs, and notarizes Suplex.app via electron-builder, then notarizes and staples the DMG so it verifies offline.
# Run through `op run --env-file signing.env` (see package.json dist:signed) so the APPLE_* variables come from 1Password.
set -eu
cd "$(dirname "$0")/.."
arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
# Without the feed, electron-builder omits app-update.yml and the release can never update itself (0.1.4 shipped that way).
: "${SUPLEX_DESKTOP_UPDATE_URL:?Set SUPLEX_DESKTOP_UPDATE_URL in signing.env; a release without it cannot auto-update}"
# signing.env holds the Apple silicon feed (.../stable/mac/arm64/); each architecture updates from its own folder beside it.
SUPLEX_DESKTOP_UPDATE_URL="$(printf %s "$SUPLEX_DESKTOP_UPDATE_URL" | sed -E "s#/mac/arm64/?\$#/mac/$arch/#")"
export SUPLEX_DESKTOP_UPDATE_URL
release="release/$arch"
dmg="$release/Suplex-$(node -p "require('./package.json').version")-$arch.dmg"
# A rerun after a later failure keeps a DMG that is already notarized and stapled.
if xcrun stapler validate -q "$dmg" 2>/dev/null; then echo "$dmg is already stapled; skipping"; exit 0; fi
pnpm dist
grep -qx "url: ${SUPLEX_DESKTOP_UPDATE_URL%/}/" "$release"/mac*/Suplex.app/Contents/Resources/app-update.yml || { echo "Suplex.app has no update feed for $SUPLEX_DESKTOP_UPDATE_URL" >&2; exit 1; }
auth="--apple-id $APPLE_ID --password $APPLE_APP_SPECIFIC_PASSWORD --team-id $APPLE_TEAM_ID"
# notarytool exits 0 when Apple rejects the file, so read the status and print Apple's log.
result="$(xcrun notarytool submit "$dmg" $auth --wait --output-format json)"
if [ "$(printf %s "$result" | node -p 'JSON.parse(require("fs").readFileSync(0)).status')" != Accepted ]; then
  xcrun notarytool log "$(printf %s "$result" | node -p 'JSON.parse(require("fs").readFileSync(0)).id')" $auth >&2
  echo "Apple did not accept $dmg. Run the release again to resume." >&2
  exit 1
fi
xcrun stapler staple "$dmg"
