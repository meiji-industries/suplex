#!/bin/sh
# Builds one architecture of the Linux desktop app (deb and rpm) under desktop/release/linux-<arch>/.
# Runs on Linux, inside the container scripts/build-desktop-linux.sh starts. Never publishes. The packages
# are unsigned here: scripts/build-desktop-linux.sh signs the update files on the Mac, so the updater
# private key never enters the container.
#
#   SUPLEX_DESKTOP_ARCH            x64 or arm64; must match this machine
#   SUPLEX_DESKTOP_FEED            this platform's HTTPS feed folder; adds app-update.yml
#   SUPLEX_DESKTOP_UPDATER_PUBKEY  the updater public key compiled into the app; without it updates are off
#   SUPLEX_SKIP_WEB_BUILD=1        reuse dist/web (the container has no node_modules)
set -eu
cd "$(dirname "$0")/.."
desktop="$PWD"

arch="${SUPLEX_DESKTOP_ARCH:-x64}"
case "$arch:$(uname -m)" in
  x64:x86_64) target=x86_64-unknown-linux-gnu ;;
  arm64:aarch64) target=aarch64-unknown-linux-gnu ;;
  *) echo "SUPLEX_DESKTOP_ARCH=$arch does not match this $(uname -m) machine" >&2; exit 1 ;;
esac
version="$(node -p "require('./package.json').version")"
feed="${SUPLEX_DESKTOP_FEED:-}"
case "$feed" in ""|https://*/) ;; *) echo "SUPLEX_DESKTOP_FEED must be an HTTPS URL ending in /" >&2; exit 1 ;; esac
release="release/linux-$arch"
work=".build/linux-$arch"

SUPLEX_DESKTOP_ARCH="$arch" sh ../scripts/bundle-runtime.sh

rm -rf "$work" "$release"
mkdir -p "$work/resources" "$release"
[ -z "$feed" ] || printf 'provider: generic\nurl: %s\n' "$feed" > "$work/resources/app-update.yml"
node --input-type=module - "$work" "$feed" "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" <<'NODE'
import { writeFileSync } from "node:fs";
const [work, feed, pubkey] = process.argv.slice(2);
const resources = { "../runtime/bin/suplex": "runtime/bin/suplex", "../runtime/manifest.json": "runtime/manifest.json" };
if (feed) resources[`../${work}/resources/app-update.yml`] = "app-update.yml";
writeFileSync(`${work}/tauri.json`, JSON.stringify({ bundle: { resources, createUpdaterArtifacts: false }, plugins: { updater: { pubkey } } }, null, 2));
NODE

unset RUSTUP_TOOLCHAIN
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$desktop/src-tauri/target}"
tauri build --ci --target "$target" --bundles deb,rpm --config "$work/tauri.json"

bundle="$CARGO_TARGET_DIR/$target/release/bundle"
[ "$(ls "$bundle"/deb/*.deb | wc -l)" -eq 1 ] && [ "$(ls "$bundle"/rpm/*.rpm | wc -l)" -eq 1 ] || { echo "Expected one deb and one rpm in $bundle" >&2; exit 1; }
cp "$bundle"/deb/*.deb "$release/Suplex-$version-linux-$arch.deb"
cp "$bundle"/rpm/*.rpm "$release/Suplex-$version-linux-$arch.rpm"
if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ]; then
  # The shell must hold this build's updater key, not one compiled into an earlier build.
  extracted="$(mktemp -d)"
  dpkg-deb -x "$release/Suplex-$version-linux-$arch.deb" "$extracted"
  grep -aqF "$SUPLEX_DESKTOP_UPDATER_PUBKEY" "$extracted/usr/bin/Suplex" || { echo "The built app does not hold SUPLEX_DESKTOP_UPDATER_PUBKEY." >&2; exit 1; }
  rm -rf "$extracted"
fi
printf '%s%s\n' "$(git rev-parse HEAD)" "$([ -z "$(git status --porcelain)" ] || echo -dirty)" > "$release/.commit"
echo "Built $release:"
ls -1 "$release"
