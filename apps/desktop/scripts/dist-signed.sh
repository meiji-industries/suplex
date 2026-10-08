#!/bin/sh
# Builds the signed, notarized, and stapled release for one architecture (SUPLEX_DESKTOP_ARCH), with both
# update feeds. Run through `op run --env-file signing.env` (pnpm desktop:dist:signed) so the Apple and
# updater credentials come from 1Password. Never publishes.
set -eu
cd "$(dirname "$0")/.."
arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
missing=""
for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID SUPLEX_DESKTOP_UPDATE_URL SUPLEX_DESKTOP_UPDATER_PUBKEY TAURI_SIGNING_PRIVATE_KEY; do
  eval "[ -n \"\${$name:-}\" ]" || missing="$missing $name"
done
# A release without a feed or updater key could never update itself, and one with a placeholder key must never ship.
[ -z "$missing" ] || { echo "A signed release needs:$missing (see docs/updates.md)." >&2; exit 1; }
# The embedded updater key must be the production key: installed apps accept updates signed by that key only.
[ -f updater-production.pub ] || { echo "apps/desktop/updater-production.pub is missing. Commit the production updater public key before a signed release." >&2; exit 1; }
[ "$SUPLEX_DESKTOP_UPDATER_PUBKEY" = "$(tr -d '[:space:]' < updater-production.pub)" ] || { echo "SUPLEX_DESKTOP_UPDATER_PUBKEY is not the production updater key in apps/desktop/updater-production.pub." >&2; exit 1; }
export APPLE_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application}"
version="$(node -p "require('./package.json').version")"
release="release/$arch"
dmg="$release/Suplex-$version-$arch.dmg"
# A rerun after a later failure keeps a release that is already notarized and stapled, when it was built from this commit.
commit="$(git rev-parse HEAD)$([ -z "$(git status --porcelain)" ] || echo -dirty)"
if xcrun stapler validate -q "$dmg" 2>/dev/null && [ "$(cat "$release/.commit" 2>/dev/null)" = "$commit" ]; then
  echo "$dmg is already stapled; skipping"
  SUPLEX_REQUIRE_UPDATER=1 SUPLEX_DESKTOP_ARCH="$arch" sh scripts/verify-release.sh
  exit 0
fi

# The bundled host is a separate executable; sign it with the hardened runtime before the app bundle is sealed.
sh ../../scripts/bundle-runtime.sh
codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" runtime/bin/suplex
# tauri build signs, notarizes, and staples Suplex.app (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID) before it
# creates the DMG and the signed updater archive, so every archive holds the final app.
SUPLEX_SKIP_RUNTIME_BUILD=1 sh scripts/dist.sh

auth="--apple-id $APPLE_ID --password $APPLE_APP_SPECIFIC_PASSWORD --team-id $APPLE_TEAM_ID"
# notarytool exits 0 when Apple rejects the file, so read the status and print Apple's log.
result="$(xcrun notarytool submit "$dmg" $auth --wait --output-format json)"
if [ "$(printf %s "$result" | node -p 'JSON.parse(require("fs").readFileSync(0)).status')" != Accepted ]; then
  xcrun notarytool log "$(printf %s "$result" | node -p 'JSON.parse(require("fs").readFileSync(0)).id')" $auth >&2
  echo "Apple did not accept $dmg. Run the release again to resume." >&2
  exit 1
fi
xcrun stapler staple "$dmg"
SUPLEX_REQUIRE_UPDATER=1 SUPLEX_DESKTOP_ARCH="$arch" sh scripts/verify-release.sh
