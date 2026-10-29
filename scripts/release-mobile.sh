#!/usr/bin/env bash
# Builds the iOS and Android shells from the latest v* tag, signs them, and uploads them: iOS to App Review,
# Android to the Play track in SUPLEX_PLAY_TRACK (default internal). Run through `op run --env-file apps/mobile/release.env`
# (mise run mobile:release). SUPLEX_MOBILE_PLATFORMS=ios or android limits the platforms.
# Signed files stay in apps/mobile/release/<tag> for a manual upload.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
platforms="${SUPLEX_MOBILE_PLATFORMS:-ios android}"

git fetch -q --tags origin
tag="$(git tag --list 'v*' --sort=-v:refname | head -1)"
version="${tag#v}"
missing=""
for name in ANDROID_UPLOAD_KEYSTORE ANDROID_UPLOAD_KEY_PASSWORD; do [[ "$platforms" != *android* || -n "${!name:-}" ]] || missing="$missing $name"; done
for name in APPLE_API_KEY APPLE_API_ISSUER APPLE_API_PRIVATE_KEY; do [[ "$platforms" != *ios* || -n "${!name:-}" ]] || missing="$missing $name"; done
[[ -z "$missing" ]] || { echo "Add$missing to the \"Mobile store release\" item in the 1Password Suplex vault." >&2; exit 1; }

# One reusable checkout keeps the Rust build cache between releases; the tag decides what ships.
build="${XDG_CACHE_HOME:-$HOME/.cache}/suplex/mobile-release"
git worktree prune
[[ -d "$build" ]] || git worktree add --detach "$build" "$tag"
git -C "$build" checkout -q --force --detach "$tag"
pnpm --dir "$build" install --frozen-lockfile --filter suplex-mobile --filter suplex-web
node "$build/scripts/third-party-licenses.mjs" "$build/apps/mobile/src/third-party-licenses.txt"
out="$root/apps/mobile/release/$tag"
mkdir -p "$out"
secrets="$(mktemp -d)"
trap 'rm -rf "$secrets"' EXIT
echo "Releasing Suplex $version for $platforms"

if [[ "$platforms" == *ios* ]]; then
  printf '%s\n' "$APPLE_API_PRIVATE_KEY" >"$secrets/AuthKey_$APPLE_API_KEY.p8"
  # Tauri passes the API key to xcodebuild, which manages the distribution certificate and provisioning profile.
  APPLE_API_KEY_PATH="$secrets/AuthKey_$APPLE_API_KEY.p8" pnpm --dir "$build/apps/mobile" tauri ios build --ci --export-method app-store-connect
  cp "$build"/apps/mobile/src-tauri/gen/apple/build/arm64/*.ipa "$out/Suplex-$version.ipa"
  API_PRIVATE_KEYS_DIR="$secrets" xcrun altool --upload-app --type ios --file "$out/Suplex-$version.ipa" --apiKey "$APPLE_API_KEY" --apiIssuer "$APPLE_API_ISSUER"
  node scripts/submit-app-store.mjs "$version"
fi

if [[ "$platforms" == *android* ]]; then
  export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)}"
  pnpm --dir "$build/apps/mobile" tauri android build --ci --aab
  aab="$out/Suplex-$version.aab"
  cp "$build/apps/mobile/src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab" "$aab"
  printf '%s' "$ANDROID_UPLOAD_KEYSTORE" | base64 -d >"$secrets/upload.jks"
  "$JAVA_HOME/bin/jarsigner" -keystore "$secrets/upload.jks" -storepass:env ANDROID_UPLOAD_KEY_PASSWORD "$aab" upload
  # Google Play accepts API uploads only after the first bundle is uploaded by hand in the Play Console.
  if [[ -z "${GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:-}" ]]; then
    echo "No Play service account: upload $aab in the Play Console."
  else
    node scripts/publish-play.mjs "$aab" "$version"
  fi
fi
