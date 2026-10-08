#!/bin/sh
# Validates built release files locally without uploading: package checks, signatures and notarization when
# the build is signed, both update manifests, and a dry run of the publisher. SUPLEX_DESKTOP_ARCH limits the
# check to one architecture; otherwise every built architecture is checked.
set -eu
cd "$(dirname "$0")/.."
arches="${SUPLEX_DESKTOP_ARCH:-}"
[ -n "$arches" ] || arches="$(for arch in arm64 x64; do [ -d "release/$arch/Suplex.app" ] && echo "$arch"; done)"
[ -n "$arches" ] || { echo "No release is built. Run pnpm desktop:dist first." >&2; exit 1; }
version="$(node -p "require('./package.json').version")"
for arch in $arches; do
  release="release/$arch"
  echo "== $release"
  SUPLEX_DESKTOP_ARCH="$arch" sh scripts/test-packaged.sh
  app="$release/Suplex.app"
  team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  if [ -z "$team" ] || [ "$team" = "not set" ]; then
    echo "note $release is signed ad hoc: Developer ID, notarization, and Gatekeeper are not verified"
    [ -z "${SUPLEX_REQUIRE_UPDATER:-}" ] || { echo "A release build must be Developer ID signed." >&2; exit 1; }
  else
    spctl --assess --type execute -vv "$app"
    xcrun stapler validate "$app"
    xcrun stapler validate "$release/Suplex-$version-$arch.dmg"
    extracted="$(mktemp -d)"
    ditto -x -k "$release/Suplex-$version-$arch-mac.zip" "$extracted"
    spctl --assess --type execute "$extracted/Suplex.app"
    [ "$(codesign -dv "$extracted/Suplex.app" 2>&1 | sed -n 's/^TeamIdentifier=//p')" = "$team" ]
    codesign -dv "$app/Contents/Resources/runtime/bin/suplex" 2>&1 | grep -qx "TeamIdentifier=$team"
    rm -rf "$extracted"
  fi
  if [ -f "$app/Contents/Resources/app-update.yml" ]; then
    feed="$(sed -n 's/^url: //p' "$app/Contents/Resources/app-update.yml")"
    (cd ../.. && SUPLEX_PUBLISH_DRY_RUN=1 SUPLEX_DESKTOP_ARCH="$arch" SUPLEX_DESKTOP_UPDATE_URL="$feed" bash scripts/publish-desktop-release.sh)
  else
    echo "note publisher dry run skipped: $release has no update feed"
  fi
done
echo "Release verification passed: $arches"
