#!/bin/sh
# Finishes a Linux or Windows release folder on the Mac: the download manifest, and with an updater key pair
# the update signatures and latest-tauri.json. The private key stays on this machine; the build container
# and VM never receive it.
#
#   SUPLEX_DESKTOP_PLATFORM        linux or windows
#   SUPLEX_DESKTOP_ARCH            x64 or arm64
#   SUPLEX_DESKTOP_FEED            this platform's HTTPS feed folder; needed for latest-tauri.json
#   TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]  signs the update files; without it no latest-tauri.json is written
#   SUPLEX_DESKTOP_UPDATER_PUBKEY  the key the build compiled in; every signature must verify against it
set -eu
cd "$(dirname "$0")/.."

platform="${SUPLEX_DESKTOP_PLATFORM:?Set SUPLEX_DESKTOP_PLATFORM to linux or windows}"
arch="${SUPLEX_DESKTOP_ARCH:?Set SUPLEX_DESKTOP_ARCH to x64 or arm64}"
case "$arch" in x64) updater_arch=x86_64 ;; arm64) updater_arch=aarch64 ;; *) echo "SUPLEX_DESKTOP_ARCH must be x64 or arm64" >&2; exit 1 ;; esac
version="$(node -p "require('./package.json').version")"
release="release/$platform-$arch"
case "$platform" in
  linux) files="Suplex-$version-linux-$arch.deb:deb Suplex-$version-linux-$arch.rpm:rpm"; manifest=latest-linux-desktop.yml ;;
  windows) files="Suplex-$version-windows-$arch-setup.exe:nsis"; manifest=latest-windows.yml ;;
  *) echo "SUPLEX_DESKTOP_PLATFORM must be linux or windows" >&2; exit 1 ;;
esac
for entry in $files; do
  [ -f "$release/${entry%%:*}" ] || { echo "Missing $release/${entry%%:*}" >&2; exit 1; }
done

# The download page reads the file names; the first is the default download.
{
  echo "version: $version"
  echo "files:"
  for entry in $files; do echo "  - url: ${entry%%:*}"; done
} > "$release/$manifest"

rm -f "$release"/*.sig "$release/latest-tauri.json"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "No updater key: $release has no update signatures or latest-tauri.json, and installs from it do not update."
  exit 0
fi
feed="${SUPLEX_DESKTOP_FEED:?The update manifest needs SUPLEX_DESKTOP_FEED}"
: "${SUPLEX_DESKTOP_UPDATER_PUBKEY:?Set SUPLEX_DESKTOP_UPDATER_PUBKEY, the key the build compiled in}"
for entry in $files; do
  file="$release/${entry%%:*}"
  pnpm exec tauri signer sign "$file" >/dev/null
  [ -f "$file.sig" ] || { echo "tauri signer wrote no $file.sig" >&2; exit 1; }
  # A key pair that does not match the key in the app would make installed apps reject every later update.
  SUPLEX_UPDATER_ARCHIVE="$PWD/$file" SUPLEX_UPDATER_SIGNATURE="$PWD/$file.sig" \
    env -u RUSTUP_TOOLCHAIN cargo test --quiet --manifest-path src-tauri/Cargo.toml --test updater_signature -- --ignored >/dev/null
done
node --input-type=module - "$release" "$version" "$platform" "$updater_arch" "$feed" $files <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [release, version, platform, arch, feed, ...files] = process.argv.slice(2);
const platforms = Object.fromEntries(files.map((entry) => {
  const [name, kind] = entry.split(":");
  return [`${platform}-${arch}-${kind}`, { signature: readFileSync(`${release}/${name}.sig`, "utf8").trim(), url: `${feed}${name}` }];
}));
writeFileSync(`${release}/latest-tauri.json`, `${JSON.stringify({ version, notes: `Suplex ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
NODE
echo "Signed $release:"
ls -1 "$release"
