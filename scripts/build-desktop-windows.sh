#!/bin/sh
# Builds the Windows desktop installer (NSIS, per-user) for each architecture in SUPLEX_WINDOWS_ARCHES
# (default "arm64 x64") under apps/desktop/release/windows-<arch>/, then finishes each folder on this Mac with
# apps/desktop/scripts/finish-platform-release.sh. Both architectures cross-compile from Linux in Docker with
# cargo-xwin (apps/desktop/windows/Dockerfile); the build runs on the build-host tailnet host when it answers.
# Windows runs no local host, so nothing else is bundled. Never publishes. --check runs the shell's clippy for the
# Windows targets instead; its tests need a Windows machine.
#
#   SUPLEX_DESKTOP_REUSE=1         keep a folder already signed from this commit (a release rerun)
#   SUPLEX_DESKTOP_UPDATE_URL      the Apple silicon feed (.../stable/mac/arm64/); each architecture updates
#                                  from .../stable/windows/<arch>/ beside it
#   SUPLEX_DESKTOP_UPDATER_PUBKEY, TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]
#                                  the updater key pair; both or neither, and the updater needs the feed
#   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
#   AZURE_CERTIFICATE_PROFILE      Azure Trusted Signing; with all six the app and installer are Authenticode
#                                  signed, otherwise Windows shows an unknown publisher
set -eu
cd "$(dirname "$0")/.."

if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] && [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "Set both SUPLEX_DESKTOP_UPDATER_PUBKEY and TAURI_SIGNING_PRIVATE_KEY, or neither." >&2; exit 1; }
  [ -n "${SUPLEX_DESKTOP_UPDATE_URL:-}" ] || { echo "The Tauri updater needs SUPLEX_DESKTOP_UPDATE_URL." >&2; exit 1; }
fi
case "${SUPLEX_DESKTOP_UPDATE_URL:-}" in ""|https://*/mac/arm64|https://*/mac/arm64/) ;; *) echo "SUPLEX_DESKTOP_UPDATE_URL must be an HTTPS URL ending in /mac/arm64/" >&2; exit 1 ;; esac
docker info >/dev/null 2>&1 || { echo "Start Docker; the Windows desktop build runs in Docker." >&2; exit 1; }

mode="${1:-build}"
# The container has no node_modules, so the web client is built here once.
[ "$mode" = --check ] || pnpm --filter suplex-web build
# The checkout and its Git directory keep their host paths, so build.rs can stamp the revision.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
commit="$(sh scripts/release-base.sh)"
. scripts/linux-builder.sh
# The image is the same for both Windows architectures; only the host decides its platform.
linux_builder x64
platform=linux/amd64
[ -n "$builder" ] || platform=""
dock build --quiet ${platform:+--platform "$platform"} -t suplex-desktop-windows apps/desktop/windows >/dev/null
for arch in ${SUPLEX_WINDOWS_ARCHES:-arm64 x64}; do
  case "$arch" in arm64) target=aarch64-pc-windows-msvc ;; x64) target=x86_64-pc-windows-msvc ;; *) echo "SUPLEX_WINDOWS_ARCHES holds arm64 and x64, not $arch" >&2; exit 1 ;; esac
  feed=""
  [ -z "${SUPLEX_DESKTOP_UPDATE_URL:-}" ] || feed="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/windows/$arch#")/"
  # A release rerun keeps a signed build of this same commit instead of building it again.
  if [ "$mode" != --check ] && [ -n "${SUPLEX_DESKTOP_REUSE:-}" ] && [ -f "apps/desktop/release/windows-$arch/latest-tauri.json" ] \
    && [ "$(cat "apps/desktop/release/windows-$arch/.commit" 2>/dev/null)" = "$commit" ]; then
    echo "apps/desktop/release/windows-$arch is already built from $commit; skipping"
    continue
  fi
  builder_push
  run() {
    dock run --rm ${platform:+--platform "$platform"} \
      -v "$PWD:$PWD" -v "$common:$common:ro" \
      -v "suplex-desktop-windows-target:/target" -v "suplex-desktop-windows-cargo:/usr/local/cargo/registry" \
      -w "$PWD/apps/desktop" \
      -e CARGO_TARGET_DIR=/target -e XWIN_CACHE_DIR=/target/xwin -e SUPLEX_SKIP_WEB_BUILD=1 \
      -e SUPLEX_DESKTOP_ARCH="$arch" -e SUPLEX_DESKTOP_FEED="$feed" -e SUPLEX_DESKTOP_UPDATER_PUBKEY \
      -e AZURE_TENANT_ID -e AZURE_CLIENT_ID -e AZURE_CLIENT_SECRET -e AZURE_SIGNING_ENDPOINT -e AZURE_SIGNING_ACCOUNT -e AZURE_CERTIFICATE_PROFILE \
      suplex-desktop-windows "$@"
  }
  if [ "$mode" = --check ]; then
    echo "Checking the desktop shell for Windows $arch"
    run sh -c "cd src-tauri && cargo xwin clippy --all-targets --target $target -- -D warnings"
    continue
  fi
  echo "Building the Windows $arch desktop app in Docker"
  run sh scripts/dist-windows.sh
  builder_pull "apps/desktop/release/windows-$arch"
  SUPLEX_DESKTOP_PLATFORM=windows SUPLEX_DESKTOP_ARCH="$arch" SUPLEX_DESKTOP_FEED="$feed" sh apps/desktop/scripts/finish-platform-release.sh
done
