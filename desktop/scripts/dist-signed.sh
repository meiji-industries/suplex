#!/bin/sh
# Builds, signs, and notarizes Suplex.app via electron-builder, then notarizes and staples the DMG so it verifies offline.
# Run through `op run --env-file signing.env` (see package.json dist:signed) so the APPLE_* variables come from 1Password.
set -eu
cd "$(dirname "$0")/.."
# Without the feed, electron-builder omits app-update.yml and the release can never update itself (0.1.4 shipped that way).
: "${SUPLEX_DESKTOP_UPDATE_URL:?Set SUPLEX_DESKTOP_UPDATE_URL in signing.env; a release without it cannot auto-update}"
pnpm dist
grep -qx "url: ${SUPLEX_DESKTOP_UPDATE_URL%/}/" release/mac-arm64/Suplex.app/Contents/Resources/app-update.yml || { echo "Suplex.app has no update feed for $SUPLEX_DESKTOP_UPDATE_URL" >&2; exit 1; }
dmg="release/Suplex-$(node -p "require('./package.json').version")-arm64.dmg"
xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$dmg"
