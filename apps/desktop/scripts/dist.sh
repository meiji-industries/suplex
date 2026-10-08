#!/bin/sh
# Builds one architecture of Suplex.app and its local distribution files under apps/desktop/release/<arch>/.
# Never publishes, installs, or replaces an app.
#
#   SUPLEX_DESKTOP_ARCH          arm64 (default) or x64
#   SUPLEX_DESKTOP_UPDATE_URL    HTTPS feed base ending in /mac/arm64/; adds app-update.yml and latest-mac.yml
#   SUPLEX_DESKTOP_UPDATER_PUBKEY, TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]
#                                Tauri updater key pair; adds the updater archive, signature, and latest-tauri.json
#   APPLE_SIGNING_IDENTITY       codesign identity; without it the app is signed ad hoc
set -eu
cd "$(dirname "$0")/.."
desktop="$PWD"

arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
case "$arch" in
  arm64) target=aarch64-apple-darwin; platform=darwin-aarch64 ;;
  x64) target=x86_64-apple-darwin; platform=darwin-x86_64 ;;
  *) echo "SUPLEX_DESKTOP_ARCH must be arm64 or x64, not $arch" >&2; exit 1 ;;
esac
version="$(node -p "require('./package.json').version")"
release="release/$arch"
work=".build/$arch"
feed=""
if [ -n "${SUPLEX_DESKTOP_UPDATE_URL:-}" ]; then
  case "$SUPLEX_DESKTOP_UPDATE_URL" in https://*) ;; *) echo "SUPLEX_DESKTOP_UPDATE_URL must be an HTTPS URL" >&2; exit 1 ;; esac
  # The configured feed names the Apple silicon folder; each architecture updates from its own folder beside it.
  feed="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/mac/$arch#")/"
fi
updater=""
if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] && [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "Set both SUPLEX_DESKTOP_UPDATER_PUBKEY and TAURI_SIGNING_PRIVATE_KEY, or neither." >&2; exit 1; }
  [ -n "$feed" ] || { echo "The Tauri updater needs SUPLEX_DESKTOP_UPDATE_URL." >&2; exit 1; }
  updater=1
fi

# The web assets first, so the host embeds them; then the host for this architecture.
# dist-signed.sh builds and signs the host itself before calling this script.
[ -n "${SUPLEX_SKIP_RUNTIME_BUILD:-}" ] || sh ../../scripts/bundle-runtime.sh

rm -rf "$work" "$release"
mkdir -p "$work/resources" "$release"
if [ -n "$feed" ]; then
  printf 'provider: generic\nurl: %s\n' "$feed" > "$work/resources/app-update.yml"
fi
node --input-type=module - "$work" "$feed" "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" "${APPLE_SIGNING_IDENTITY:-}" <<'NODE'
import { writeFileSync } from "node:fs";
const [work, feed, pubkey, identity] = process.argv.slice(2);
const resources = { "../runtime/bin/suplex": "runtime/bin/suplex", "../runtime/manifest.json": "runtime/manifest.json" };
if (feed) resources[`../${work}/resources/app-update.yml`] = "app-update.yml";
writeFileSync(`${work}/tauri.json`, JSON.stringify({
  bundle: {
    resources,
    createUpdaterArtifacts: Boolean(pubkey),
    macOS: { signingIdentity: identity || "-" },
  },
  plugins: { updater: { pubkey } },
}, null, 2));
NODE

unset RUSTUP_TOOLCHAIN
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(dirname "$(dirname "$desktop")")/target}"
# The DMG window layout is drawn by Finder through AppleScript. Without Automation access (a CI runner or a
# background agent) the bundler would wait for Finder and fail, so the DMG is built without the layout.
if [ "${CI:-}" != true ] && ! osascript -e 'with timeout of 5 seconds' -e 'tell application "Finder" to get name of startup disk' -e 'end timeout' >/dev/null 2>&1; then
  echo "Finder automation is not available: the DMG has no window layout." >&2
  export CI=true
fi
pnpm exec tauri build --ci --target "$target" --bundles app,dmg --config "$work/tauri.json"

bundle="$CARGO_TARGET_DIR/$target/release/bundle"
app="$bundle/macos/Suplex.app"
[ -d "$app" ] || { echo "tauri build produced no $app" >&2; exit 1; }
# The shell must hold this build's updater key, not one compiled into an earlier build.
[ -z "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] || grep -aqF "$SUPLEX_DESKTOP_UPDATER_PUBKEY" "$app/Contents/MacOS/Suplex" || { echo "The built app does not hold SUPLEX_DESKTOP_UPDATER_PUBKEY." >&2; exit 1; }
ditto "$app" "$release/Suplex.app"
dmg="$(ls "$bundle"/dmg/*.dmg | head -1)"
cp "$dmg" "$release/Suplex-$version-$arch.dmg"
# The ZIP the CLI updater, install script, and download page use. Built from the final app; never modified after hashing.
ditto -c -k --sequesterRsrc --keepParent "$release/Suplex.app" "$release/Suplex-$version-$arch-mac.zip"

if [ -n "$feed" ]; then
  node --input-type=module - "$release" "$version" "$arch" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [release, version, arch] = process.argv.slice(2);
const zip = `Suplex-${version}-${arch}-mac.zip`;
// Only the fields its readers use: apps/server/src/platform/app_update.rs (version, path, sha512) and the download handlers (files[].url).
writeFileSync(`${release}/latest-mac.yml`, [
  `version: ${version}`,
  "files:",
  `  - url: ${zip}`,
  `  - url: Suplex-${version}-${arch}.dmg`,
  `path: ${zip}`,
  `sha512: ${createHash("sha512").update(readFileSync(`${release}/${zip}`)).digest("base64")}`,
  "",
].join("\n"));
NODE
fi

if [ -n "$updater" ]; then
  archive="$bundle/macos/Suplex.app.tar.gz"
  [ -f "$archive" ] && [ -f "$archive.sig" ] || { echo "tauri build produced no signed updater archive" >&2; exit 1; }
  # Copied byte for byte: the signature covers these exact bytes.
  cp "$archive" "$release/Suplex-$version-$arch.app.tar.gz"
  cp "$archive.sig" "$release/Suplex-$version-$arch.app.tar.gz.sig"
  # A key pair that does not match, or a leftover test key, would make installed apps reject every later update.
  SUPLEX_UPDATER_ARCHIVE="$PWD/$release/Suplex-$version-$arch.app.tar.gz" SUPLEX_UPDATER_SIGNATURE="$PWD/$release/Suplex-$version-$arch.app.tar.gz.sig" \
    env -u RUSTUP_TOOLCHAIN cargo test --manifest-path src-tauri/Cargo.toml --test updater_signature -- --ignored
  node --input-type=module - "$release" "$version" "$arch" "$platform" "$feed" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [release, version, arch, platform, feed] = process.argv.slice(2);
const name = `Suplex-${version}-${arch}.app.tar.gz`;
writeFileSync(`${release}/latest-tauri.json`, `${JSON.stringify({
  version,
  notes: `Suplex ${version}`,
  pub_date: new Date().toISOString(),
  platforms: { [platform]: { signature: readFileSync(`${release}/${name}.sig`, "utf8").trim(), url: `${feed}${name}` } },
}, null, 2)}\n`);
NODE
fi

# The commit this release was built from; dist-signed.sh reuses a stapled release only from the same commit.
printf '%s%s\n' "$(git rev-parse HEAD)" "$([ -z "$(git status --porcelain)" ] || echo -dirty)" > "$release/.commit"

echo "Built $release:"
ls -1 "$release"
[ -n "$feed" ] || echo "No SUPLEX_DESKTOP_UPDATE_URL: this build has no update feed, app-update.yml, or latest-mac.yml."
[ -n "$updater" ] || echo "No updater key pair: this build has no Tauri updater archive, signature, or latest-tauri.json, and its updater is disabled."
