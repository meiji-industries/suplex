#!/usr/bin/env bash
# One release target through one phase. The release tasks run every target through
# build, then files, then manifest, so a failed upload leaves the previous release live.
#   release-target.sh expand [target...]   print the full target list (every target when empty)
#   release-target.sh build|files|manifest <target>
# Targets: mac, linux-cli, linux-desktop, windows, each optionally -arm64 or -x64.
set -euo pipefail
cd "$(dirname "$0")/.."
all="mac-arm64 mac-x64 linux-cli-arm64 linux-cli-x64 linux-desktop-arm64 linux-desktop-x64 windows-arm64 windows-x64"
phase="${1:?phase: expand, build, files, or manifest}"
shift

expand() {
  [[ $# -gt 0 ]] || { echo "$all"; return; }
  local out=" " name names n
  for name in "$@"; do
    case "$name" in
      mac|linux-cli|linux-desktop|windows) names="$name-arm64 $name-x64" ;;
      *) names="$name" ;;
    esac
    for n in $names; do
      [[ " $all " == *" $n "* ]] || { echo "Unknown release target $name. Targets: $all" >&2; return 1; }
      [[ "$out" == *" $n "* ]] || out+="$n "
    done
  done
  out="${out# }"
  echo "${out% }"
}

if [[ "$phase" == expand ]]; then
  expand "$@"
  exit
fi
target="${1:?target}"
[[ " $all " == *" $target "* ]] || { echo "Unknown release target $target. Targets: $all" >&2; exit 1; }
platform="${target%-*}"
arch="${target##*-}"
source scripts/onepassword.sh
onepassword_setup_service_account
export SUPLEX_DESKTOP_REUSE=1
# The build phase runs the publisher as a dry run, which checks every publish phase.
[[ "$phase" == build ]] || export SUPLEX_PUBLISH_PHASE="$phase"
signed() { op run --env-file apps/desktop/signing.env -- "$@"; }
published() { op run --env-file apps/desktop/release.env -- "$@"; }
case "$phase:$platform" in
  build:mac) SUPLEX_DESKTOP_ARCH=$arch pnpm run desktop:dist:signed ;;
  build:linux-cli) SUPLEX_LINUX_ARCH=$arch signed sh scripts/build-linux.sh ;;
  build:linux-desktop) SUPLEX_LINUX_ARCHES=$arch signed sh scripts/build-desktop-linux.sh ;;
  build:windows)
    # Optional Authenticode signing; without the item the installers show an unknown publisher.
    for name in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_SIGNING_ENDPOINT AZURE_SIGNING_ACCOUNT AZURE_CERTIFICATE_PROFILE; do
      value="$(op read "op://Suplex/Azure Trusted Signing/$name" 2>/dev/null)" && export "$name=$value"
    done
    SUPLEX_WINDOWS_ARCHES=$arch signed bash scripts/build-desktop-windows.sh ;;
  files:mac|manifest:mac) SUPLEX_DESKTOP_ARCH=$arch published pnpm run desktop:publish ;;
  files:linux-cli|manifest:linux-cli) SUPLEX_LINUX_ARCH=$arch published bash scripts/publish-linux-release.sh ;;
  files:linux-desktop|manifest:linux-desktop) SUPLEX_DESKTOP_PLATFORM=linux SUPLEX_DESKTOP_ARCH=$arch published bash scripts/publish-desktop-platform-release.sh ;;
  files:windows|manifest:windows) SUPLEX_DESKTOP_PLATFORM=windows SUPLEX_DESKTOP_ARCH=$arch published bash scripts/publish-desktop-platform-release.sh ;;
  *) echo "Unknown phase $phase. Phases: expand, build, files, manifest" >&2; exit 1 ;;
esac
