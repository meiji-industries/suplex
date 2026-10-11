#!/bin/sh
# Cross-compiles the Windows NSIS installer inside the build container (apps/desktop/windows/Dockerfile) and
# copies it to release/windows-<arch>/. scripts/build-desktop-windows.sh runs this.
#
#   SUPLEX_DESKTOP_ARCH            x64 or arm64
#   SUPLEX_DESKTOP_FEED            this platform's HTTPS update folder, or empty
#   SUPLEX_DESKTOP_UPDATER_PUBKEY  compiled into the app, and checked in the built executable
#   AZURE_*                        the six Azure Trusted Signing values; with all of them the app and installer are signed
set -eu
cd "$(dirname "$0")/.."
desktop="$PWD"

arch="${SUPLEX_DESKTOP_ARCH:?Set SUPLEX_DESKTOP_ARCH to x64 or arm64}"
case "$arch" in x64) target=x86_64-pc-windows-msvc ;; arm64) target=aarch64-pc-windows-msvc ;; *) echo "SUPLEX_DESKTOP_ARCH must be x64 or arm64" >&2; exit 1 ;; esac
version="$(node -p "require('./package.json').version")"
feed="${SUPLEX_DESKTOP_FEED:-}"
case "$feed" in ""|https://*/) ;; *) echo "SUPLEX_DESKTOP_FEED must be an HTTPS URL ending in /" >&2; exit 1 ;; esac
release="release/windows-$arch"
work=".build/windows-$arch"

sign_command=""
if [ -n "${AZURE_TENANT_ID:-}" ] && [ -n "${AZURE_CLIENT_ID:-}" ] && [ -n "${AZURE_CLIENT_SECRET:-}" ] \
  && [ -n "${AZURE_SIGNING_ENDPOINT:-}" ] && [ -n "${AZURE_SIGNING_ACCOUNT:-}" ] && [ -n "${AZURE_CERTIFICATE_PROFILE:-}" ]; then
  sign_command="sh $desktop/windows/sign-linux.sh %1"
  echo "Authenticode signing is on."
else
  echo "Authenticode signing is off: Windows shows Suplex as an unknown publisher. Set the six AZURE_* values to sign." >&2
fi

rm -rf "$work" "$release"
mkdir -p "$work" "$release"
[ -z "$feed" ] || printf 'provider: generic\nurl: %s\n' "$feed" > "$work/app-update.yml"
node --input-type=module - "$work" "$feed" "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" "$sign_command" <<'NODE'
import { writeFileSync } from "node:fs";
const [work, feed, pubkey, signCommand] = process.argv.slice(2);
const resources = feed ? { [`../${work}/app-update.yml`]: "app-update.yml" } : {};
const windows = signCommand ? { signCommand } : {};
writeFileSync(`${work}/tauri.json`, JSON.stringify({ bundle: { resources, createUpdaterArtifacts: false, windows }, plugins: { updater: { pubkey } } }, null, 2));
NODE

unset RUSTUP_TOOLCHAIN
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(dirname "$(dirname "$desktop")")/target}"
bundle="$CARGO_TARGET_DIR/$target/release/bundle/nsis"
# The target dir is a persistent Docker volume; Tauri leaves earlier versions' installers in it.
rm -rf "$bundle"
tauri build --ci --runner cargo-xwin --target "$target" --bundles nsis --config "$work/tauri.json"

[ "$(ls "$bundle"/*_"${version}"_*-setup.exe | wc -l)" -eq 1 ] || { echo "Expected one $version installer in $bundle" >&2; exit 1; }
cp "$bundle"/*_"${version}"_*-setup.exe "$release/Suplex-$version-windows-$arch-setup.exe"
if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ]; then
  # The shell must hold this build's updater key, not one compiled into an earlier build.
  grep -aqF "$SUPLEX_DESKTOP_UPDATER_PUBKEY" "$CARGO_TARGET_DIR/$target/release/Suplex.exe" || { echo "The built app does not hold SUPLEX_DESKTOP_UPDATER_PUBKEY." >&2; exit 1; }
fi
printf '%s\n' "$(sh ../../scripts/release-base.sh)" > "$release/.commit"
