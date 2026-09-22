#!/bin/sh
# Builds, signs, and notarizes Suplex.app via electron-builder, then notarizes and staples the DMG so it verifies offline.
# Run through `op run --env-file signing.env` (see package.json dist:signed) so the APPLE_* variables come from 1Password.
set -eu
cd "$(dirname "$0")/.."
pnpm dist
dmg=$(ls release/Suplex-*-arm64.dmg)
xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$dmg"
