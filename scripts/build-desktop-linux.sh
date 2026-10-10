#!/bin/sh
# Builds the Linux desktop app (deb and rpm, with the bundled host) in Docker for each architecture in
# SUPLEX_LINUX_ARCHES (default "arm64 x64") under apps/desktop/release/linux-<arch>/, then finishes each folder
# on this Mac with apps/desktop/scripts/finish-platform-release.sh, and checks each deb in a clean Ubuntu 22.04
# container (apps/desktop/scripts/test-packaged-linux.sh). Never publishes. --check runs the shell's clippy and
# tests in the build container instead.
#
#   SUPLEX_DESKTOP_REUSE=1         keep a folder already signed from this commit (a release rerun)
#   SUPLEX_DESKTOP_UPDATE_URL      the Apple silicon feed (.../stable/mac/arm64/); each architecture updates
#                                  from .../stable/linux/<arch>/ beside it
#   SUPLEX_DESKTOP_UPDATER_PUBKEY, TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]
#                                  the updater key pair; both or neither, and the updater needs the feed
#   SUPLEX_POSTHOG_KEY             compiled into the bundled host (docs/telemetry.md)
# The x64 build runs under emulation on Apple silicon and takes much longer than arm64.
set -eu
cd "$(dirname "$0")/.."

if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] && [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "Set both SUPLEX_DESKTOP_UPDATER_PUBKEY and TAURI_SIGNING_PRIVATE_KEY, or neither." >&2; exit 1; }
  [ -n "${SUPLEX_DESKTOP_UPDATE_URL:-}" ] || { echo "The Tauri updater needs SUPLEX_DESKTOP_UPDATE_URL." >&2; exit 1; }
fi
case "${SUPLEX_DESKTOP_UPDATE_URL:-}" in ""|https://*/mac/arm64|https://*/mac/arm64/) ;; *) echo "SUPLEX_DESKTOP_UPDATE_URL must be an HTTPS URL ending in /mac/arm64/" >&2; exit 1 ;; esac
docker info >/dev/null 2>&1 || { echo "Start Docker; the Linux desktop build runs in Docker." >&2; exit 1; }

mode="${1:-build}"
# The container has no node_modules, so the web client is built here once.
[ "$mode" = --check ] || pnpm --filter suplex-web build
# The checkout and its Git directory keep their host paths, so build.rs can stamp the revision.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
commit="$(sh scripts/release-base.sh)"
. scripts/linux-builder.sh
for arch in ${SUPLEX_LINUX_ARCHES:-arm64 x64}; do
  case "$arch" in arm64) platform=linux/arm64 ;; x64) platform=linux/amd64 ;; *) echo "SUPLEX_LINUX_ARCHES holds arm64 and x64, not $arch" >&2; exit 1 ;; esac
  feed=""
  [ -z "${SUPLEX_DESKTOP_UPDATE_URL:-}" ] || feed="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/linux/$arch#")/"
  # A release rerun keeps a signed build of this same commit instead of building it again.
  if [ -n "${SUPLEX_DESKTOP_REUSE:-}" ] && [ -f "apps/desktop/release/linux-$arch/latest-tauri.json" ] \
    && [ "$(cat "apps/desktop/release/linux-$arch/.commit" 2>/dev/null)" = "$commit" ]; then
    echo "apps/desktop/release/linux-$arch is already built from $commit; skipping"
    continue
  fi
  linux_builder "$arch"
  builder_push
  image="suplex-desktop-linux-$arch"
  dock build --quiet --platform "$platform" -t "$image" apps/desktop/linux >/dev/null
  run() {
    dock run --rm --platform "$platform" \
      -v "$PWD:$PWD" -v "$common:$common:ro" \
      -v "suplex-desktop-linux-target-$arch:/target" -v "suplex-desktop-linux-cargo-$arch:/usr/local/cargo/registry" \
      -w "$PWD/apps/desktop" \
      -e CARGO_TARGET_DIR=/target -e SUPLEX_SKIP_WEB_BUILD=1 -e SUPLEX_DESKTOP_ARCH="$arch" -e SUPLEX_DESKTOP_FEED="$feed" \
      -e SUPLEX_DESKTOP_UPDATER_PUBKEY -e SUPLEX_POSTHOG_KEY \
      "$image" "$@"
  }
  if [ "$mode" = --check ]; then
    echo "Checking the desktop shell on Linux $arch"
    run sh -c 'cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test --all-targets'
    continue
  fi
  echo "Building the Linux $arch desktop app in Docker"
  run sh scripts/dist-linux.sh
  builder_pull "apps/desktop/release/linux-$arch"
  SUPLEX_DESKTOP_PLATFORM=linux SUPLEX_DESKTOP_ARCH="$arch" SUPLEX_DESKTOP_FEED="$feed" sh apps/desktop/scripts/finish-platform-release.sh
  builder_push "apps/desktop/release/linux-$arch"
  dock run --rm --platform "$platform" -v "$PWD/apps/desktop/release/linux-$arch:/release" -v "$PWD/apps/desktop/scripts:/scripts:ro" \
    ubuntu:22.04 sh /scripts/test-packaged-linux.sh
done
