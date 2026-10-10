#!/usr/bin/env bash
# Builds the Windows desktop installer (NSIS, per-user) on the Windows build VM for each architecture in
# SUPLEX_WINDOWS_ARCHES (default "arm64 x64") under apps/desktop/release/windows-<arch>/, then finishes each folder
# on this Mac with apps/desktop/scripts/finish-platform-release.sh. Each installer is installed and launched on the
# VM (apps/desktop/windows/test-packaged.ps1); the Arm VM runs the x64 build under emulation. Windows runs no local
# host, so nothing else is bundled. Never publishes. --check runs the shell's clippy and tests on the VM instead.
#
#   SUPLEX_DESKTOP_REUSE=1         keep a folder already signed from this commit (a release rerun)
#   SUPLEX_DESKTOP_UPDATE_URL      the Apple silicon feed (.../stable/mac/arm64/); each architecture updates
#                                  from .../stable/windows/<arch>/ beside it
#   SUPLEX_DESKTOP_UPDATER_PUBKEY, TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]
#                                  the updater key pair; both or neither, and the updater needs the feed
#   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
#   AZURE_CERTIFICATE_PROFILE      Azure Trusted Signing; with all six the app and installer are Authenticode
#                                  signed, otherwise Windows shows an unknown publisher
# apps/desktop/windows/README.md describes the VM.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
source apps/desktop/windows/vm.sh

mode="${1:-build}"
version="$(node -p "require('./apps/desktop/package.json').version")"
if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ] && [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "Set both SUPLEX_DESKTOP_UPDATER_PUBKEY and TAURI_SIGNING_PRIVATE_KEY, or neither." >&2; exit 1; }
  [ -n "${SUPLEX_DESKTOP_UPDATE_URL:-}" ] || { echo "The Tauri updater needs SUPLEX_DESKTOP_UPDATE_URL." >&2; exit 1; }
fi
case "${SUPLEX_DESKTOP_UPDATE_URL:-}" in ""|https://*/mac/arm64|https://*/mac/arm64/) ;; *) echo "SUPLEX_DESKTOP_UPDATE_URL must be an HTTPS URL ending in /mac/arm64/" >&2; exit 1 ;; esac

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
vm_start

# The shell sources and the few files its tests read: no host, node_modules, or build output.
# Cargo also loads the workspace root and each member's manifest and entry files, so those come along.
# Batch files need CRLF line endings.
echo "Copying the desktop sources to the Windows build VM ($vm_ip)"
COPYFILE_DISABLE=1 tar -C "$root" --no-xattrs \
  --exclude=apps/desktop/node_modules --exclude=apps/desktop/release --exclude=apps/desktop/.build --exclude=apps/desktop/runtime \
  --exclude=apps/desktop/src-tauri/target --exclude=apps/desktop/src-tauri/gen --exclude=apps/desktop/linux \
  -czf "$scratch/checkout.tar.gz" apps/desktop \
  package.json pnpm-workspace.yaml apps/web/vite-env.d.ts apps/server/Cargo.toml scripts/bundle-runtime.sh \
  Cargo.toml Cargo.lock apps/server/src/main.rs apps/mobile/src-tauri/Cargo.toml apps/mobile/src-tauri/src/lib.rs apps/mobile/src-tauri/src/main.rs \
  apps/bootstrap/Cargo.toml apps/bootstrap/src/main.rs
vm_put "$scratch/checkout.tar.gz" "S:/suplex/checkout.tar.gz"
# cmd runs everything after `if exist ... &` inside the if, so each step stands alone. -m gives the files
# the VM's current time: Cargo then rebuilds what changed even when the VM clock trails this Mac's.
vm_ssh "(if exist S:\\suplex\\checkout rmdir /s /q S:\\suplex\\checkout) & mkdir S:\\suplex\\checkout & (if not exist S:\\suplex\\windows mkdir S:\\suplex\\windows) & tar -xzmf S:\\suplex\\checkout.tar.gz -C S:\\suplex\\checkout && del S:\\suplex\\checkout.tar.gz"
for script in env.bat install-tools.bat build.bat check.bat sign.bat sign-task.ps1 sign-request.bat test-packaged.ps1; do
  sed 's/$/\r/' "apps/desktop/windows/$script" > "$scratch/$script"
  vm_put "$scratch/$script" "S:/suplex/windows/$script"
done
vm_ssh "S:\\suplex\\windows\\install-tools.bat"

if [ "$mode" = --check ]; then
  vm_ssh "S:\\suplex\\windows\\check.bat"
  exit 0
fi

# Authenticode signing through Azure Trusted Signing, as the VM provisioning release signs. sign.bat reads the
# service principal from the environment (the signing library's environment credential). The credentials reach
# the VM as files, never as command arguments, and the EXIT trap deletes them.
sign_command=""
vm_ssh "del S:\\suplex\\windows\\signing-env.bat S:\\suplex\\windows\\sign-task.json 2>nul" || true
if [ -n "${AZURE_TENANT_ID:-}" ] && [ -n "${AZURE_CLIENT_ID:-}" ] && [ -n "${AZURE_CLIENT_SECRET:-}" ] \
  && [ -n "${AZURE_SIGNING_ENDPOINT:-}" ] && [ -n "${AZURE_SIGNING_ACCOUNT:-}" ] && [ -n "${AZURE_CERTIFICATE_PROFILE:-}" ]; then
  case "$AZURE_CLIENT_SECRET$AZURE_SIGNING_ENDPOINT$AZURE_SIGNING_ACCOUNT$AZURE_CERTIFICATE_PROFILE" in
    *[%\"]*) echo "An AZURE_* value holds % or a double quote, which a batch file cannot carry." >&2; exit 1 ;;
  esac
  trap 'vm_ssh "del S:\suplex\windows\signing-env.bat S:\suplex\windows\sign-task.json 2>nul" >/dev/null 2>&1; rm -rf "$scratch"' EXIT
  printf '@echo off\r\nset "AZURE_TENANT_ID=%s"\r\nset "AZURE_CLIENT_ID=%s"\r\nset "AZURE_CLIENT_SECRET=%s"\r\nset "AZURE_SIGNING_ENDPOINT=%s"\r\nset "AZURE_SIGNING_ACCOUNT=%s"\r\nset "AZURE_CERTIFICATE_PROFILE=%s"\r\n' \
    "$AZURE_TENANT_ID" "$AZURE_CLIENT_ID" "$AZURE_CLIENT_SECRET" "$AZURE_SIGNING_ENDPOINT" "$AZURE_SIGNING_ACCOUNT" "$AZURE_CERTIFICATE_PROFILE" > "$scratch/signing-env.bat"
  vm_put "$scratch/signing-env.bat" "S:/suplex/windows/signing-env.bat"
  # The scheduled task that signs logs on as the VM user (sign-task.ps1).
  node -e 'process.stdout.write(JSON.stringify({ user: process.argv[1], password: process.argv[2] }))' "$(vm_setting GUEST_USER)" "$(vm_setting GUEST_PASS)" > "$scratch/sign-task.json"
  vm_put "$scratch/sign-task.json" "S:/suplex/windows/sign-task.json"
  rm -f "$scratch/signing-env.bat" "$scratch/sign-task.json"
  sign_command='powershell -NoProfile -ExecutionPolicy Bypass -File S:\suplex\windows\sign-task.ps1 %1'
  echo "Authenticode signing is on."
else
  echo "Authenticode signing is off: Windows shows Suplex as an unknown publisher. Set the six AZURE_* values to sign." >&2
fi

commit="$(sh scripts/release-base.sh)"
for arch in ${SUPLEX_WINDOWS_ARCHES:-arm64 x64}; do
  case "$arch" in arm64) target=aarch64-pc-windows-msvc ;; x64) target=x86_64-pc-windows-msvc ;; *) echo "SUPLEX_WINDOWS_ARCHES holds arm64 and x64, not $arch" >&2; exit 1 ;; esac
  feed=""
  [ -z "${SUPLEX_DESKTOP_UPDATE_URL:-}" ] || feed="$(printf %s "${SUPLEX_DESKTOP_UPDATE_URL%/}" | sed -E "s#/mac/arm64\$#/windows/$arch#")/"
  # A release rerun keeps a signed build of this same commit instead of building it again.
  if [ -n "${SUPLEX_DESKTOP_REUSE:-}" ] && [ -f "apps/desktop/release/windows-$arch/latest-tauri.json" ] \
    && [ "$(cat "apps/desktop/release/windows-$arch/.commit" 2>/dev/null)" = "$commit" ]; then
    echo "apps/desktop/release/windows-$arch is already built from $commit; skipping"
    continue
  fi
  work="$scratch/windows-$arch"
  mkdir -p "$work"
  resources="{}"
  if [ -n "$feed" ]; then
    printf 'provider: generic\nurl: %s\n' "$feed" > "$work/app-update.yml"
    resources='{"../.build/windows-'"$arch"'/app-update.yml": "app-update.yml"}'
  fi
  node --input-type=module - "$work/tauri.json" "$resources" "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" "$sign_command" <<'NODE'
import { writeFileSync } from "node:fs";
const [file, resources, pubkey, signCommand] = process.argv.slice(2);
const windows = signCommand ? { signCommand } : {};
writeFileSync(file, JSON.stringify({ bundle: { resources: JSON.parse(resources), createUpdaterArtifacts: false, windows }, plugins: { updater: { pubkey } } }, null, 2));
NODE
  vm_ssh "mkdir S:\\suplex\\checkout\\apps\\desktop\\.build\\windows-$arch 2>nul" || true
  for file in "$work"/*; do vm_put "$file" "S:/suplex/checkout/apps/desktop/.build/windows-$arch/$(basename "$file")"; done

  echo "Building the Windows $arch desktop app on the VM"
  vm_ssh "S:\\suplex\\windows\\build.bat $arch"
  bundle="S:/suplex/target/$target/release/bundle/nsis"
  installer="$(vm_ssh "dir /b S:\\suplex\\target\\$target\\release\\bundle\\nsis\\*_${version}_*-setup.exe" | tr -d '\r')"
  [ "$(printf '%s\n' "$installer" | grep -c .)" = 1 ] || { echo "Expected one installer in $bundle, found: $installer" >&2; exit 1; }
  release="apps/desktop/release/windows-$arch"
  rm -rf "$release"
  mkdir -p "$release"
  vm_get "$bundle/$installer" "$release/Suplex-$version-windows-$arch-setup.exe"
  if [ -n "${SUPLEX_DESKTOP_UPDATER_PUBKEY:-}" ]; then
    # The shell must hold this build's updater key, not one compiled into an earlier build.
    vm_get "S:/suplex/target/$target/release/Suplex.exe" "$scratch/Suplex-$arch.exe"
    grep -aqF "$SUPLEX_DESKTOP_UPDATER_PUBKEY" "$scratch/Suplex-$arch.exe" || { echo "The built app does not hold SUPLEX_DESKTOP_UPDATER_PUBKEY." >&2; exit 1; }
  fi
  # Install it for the VM's user, check the registration, and launch it against a test server.
  vm_ssh "if not exist S:\\suplex\\test mkdir S:\\suplex\\test"
  vm_put "$release/Suplex-$version-windows-$arch-setup.exe" "S:/suplex/test/setup.exe"
  vm_ssh "powershell -NoProfile -ExecutionPolicy Bypass -File S:\\suplex\\windows\\test-packaged.ps1 -Feed \"$feed\"${sign_command:+ -Signed}"
  printf '%s\n' "$(sh scripts/release-base.sh)" > "$release/.commit"
  SUPLEX_DESKTOP_PLATFORM=windows SUPLEX_DESKTOP_ARCH="$arch" SUPLEX_DESKTOP_FEED="$feed" sh apps/desktop/scripts/finish-platform-release.sh
done
