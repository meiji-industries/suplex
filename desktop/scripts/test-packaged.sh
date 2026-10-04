#!/bin/sh
# Checks a built desktop/release/<arch>/ (SUPLEX_DESKTOP_ARCH, default arm64): bundle identity and structure,
# the bundled host, archives and update metadata when present, and that no test driver, Electron, or Node
# shipped. On a Mac of the same architecture it also launches the normal packaged app against a fixture host.
set -eu
cd "$(dirname "$0")/.."
arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
case "$arch" in
  arm64) machine=arm64; platform=darwin-aarch64 ;;
  x64) machine=x86_64; platform=darwin-x86_64 ;;
  *) echo "SUPLEX_DESKTOP_ARCH must be arm64 or x64, not $arch" >&2; exit 1 ;;
esac
version="$(node -p "require('./package.json').version")"
release="release/$arch"
app="$release/Suplex.app"
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1" >&2; failures=$((failures + 1)); fi; }
plist() { plutil -extract "$1" raw -o - "$app/Contents/Info.plist" 2>/dev/null; }

[ -d "$app" ] || { echo "Packaged application not found at $app. Run pnpm desktop:dist first." >&2; exit 1; }
check "bundle identifier dev.suplex.desktop" '[ "$(plist CFBundleIdentifier)" = dev.suplex.desktop ]'
check "executable Contents/MacOS/Suplex" '[ "$(plist CFBundleExecutable)" = Suplex ] && [ -x "$app/Contents/MacOS/Suplex" ]'
check "version $version" '[ "$(plist CFBundleShortVersionString)" = "$version" ] && [ "$(plist CFBundleVersion)" = "$version" ]'
check "minimum macOS 14.0" '[ "$(plist LSMinimumSystemVersion)" = 14.0 ]'
check "suplex:// registration" '[ "$(plist CFBundleURLTypes.0.CFBundleURLSchemes.0)" = suplex ]'
check "shell is $machine only" '[ "$(lipo -archs "$app/Contents/MacOS/Suplex")" = "$machine" ]'
check "runtime holds bin and manifest.json only" '[ "$(ls "$app/Contents/Resources/runtime" | tr "\n" " ")" = "bin manifest.json " ] && [ "$(ls "$app/Contents/Resources/runtime/bin")" = suplex ]'
check "bundled host is executable and $machine" '[ -x "$app/Contents/Resources/runtime/bin/suplex" ] && [ "$(lipo -archs "$app/Contents/Resources/runtime/bin/suplex")" = "$machine" ]'
check "runtime manifest version $version" '[ "$(node -p "JSON.stringify(require(\"./$app/Contents/Resources/runtime/manifest.json\"))")" = "{\"version\":\"$version\"}" ]'
check "host embeds the web client" 'strings "$app/Contents/Resources/runtime/bin/suplex" | grep -q suplex-ui'
check "no Electron, Chromium, Node, asar, or node_modules" '! find "$app" \( -iname "*electron*" -o -name "*.asar" -o -name node_modules -o -name "*Chromium*" -o -name node \) | grep -q .'
check "no native test driver" '! grep -aq suplex-native-test-driver "$app/Contents/MacOS/Suplex"'
check "code signature verifies" 'codesign --verify --deep --strict "$app" 2>/dev/null'
check "DMG present" '[ -f "$release/Suplex-$version-$arch.dmg" ]'
zip="$release/Suplex-$version-$arch-mac.zip"
check "ZIP present" '[ -f "$zip" ]'
if [ -f "$zip" ]; then
  extracted="$(mktemp -d)"
  ditto -x -k "$zip" "$extracted"
  check "ZIP holds the same signed app" 'diff -rq "$app" "$extracted/Suplex.app" >/dev/null && codesign --verify --deep --strict "$extracted/Suplex.app" 2>/dev/null'
  rm -rf "$extracted"
fi
if [ -f "$app/Contents/Resources/app-update.yml" ]; then
  feed="$(sed -n 's/^url: //p' "$app/Contents/Resources/app-update.yml")"
  check "app-update.yml names this architecture's HTTPS feed" 'case "$feed" in https://*/mac/$arch/) true ;; *) false ;; esac'
  check "latest-mac.yml present" '[ -f "$release/latest-mac.yml" ]'
  check "latest-mac.yml matches the ZIP" 'grep -qx "version: $version" "$release/latest-mac.yml" && grep -qx "path: Suplex-$version-$arch-mac.zip" "$release/latest-mac.yml" && grep -qx "sha512: $(openssl dgst -sha512 -binary "$zip" | base64)" "$release/latest-mac.yml"'
else
  echo "note no update feed in this build: app-update.yml, latest-mac.yml, and updater files are not expected"
fi
if [ -f "$release/latest-tauri.json" ] || [ -n "${SUPLEX_REQUIRE_UPDATER:-}" ]; then
  tarball="$release/Suplex-$version-$arch.app.tar.gz"
  check "updater archive and signature present" '[ -f "$tarball" ] && [ -f "$tarball.sig" ]'
  check "latest-tauri.json names the archive and its signature" 'node -e "const m=require(\"./$release/latest-tauri.json\"); const p=m.platforms[\"$platform\"]; const sig=require(\"fs\").readFileSync(\"$tarball.sig\",\"utf8\").trim(); if (m.version!==\"$version\"||!p||p.signature!==sig||!p.url.startsWith(\"https://\")||!p.url.endsWith(\"/Suplex-$version-$arch.app.tar.gz\")) process.exit(1)"'
  check "updater archive holds the same app" 'x="$(mktemp -d)" && tar -xzf "$tarball" -C "$x" && diff -rq "$app" "$x/Suplex.app" >/dev/null; r=$?; rm -rf "$x"; [ $r = 0 ]'
fi

# Launch the normal, uninstrumented app with isolated data against a fixture host, then quit it with SIGTERM.
# A running installed Suplex owns the dev.suplex.desktop single-instance socket and would receive this launch.
installed_running() { python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(1); sys.exit(0 if s.connect_ex("/tmp/dev_suplex_desktop_si.sock")==0 else 1)' 2>/dev/null; }
if installed_running; then
  echo "note launch check skipped: an installed Suplex is running, and a second instance would hand its arguments to it"
elif [ "$(uname -m)" = "$machine" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 0 ]; then
  scratch="$(mktemp -d)"
  port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  mkdir -p "$scratch/host/data"
  env -i PATH=/usr/bin:/bin SUPLEX_DATA_ROOT="$scratch/host/data" SUPLEX_PORT="$port" src-tauri/tests/fixtures/runtime/bin/suplex start --foreground >/dev/null 2>&1 &
  host=$!
  sleep 1
  # The environment macOS gives a launched app, plus isolated data; nothing from this shell's session.
  env -i HOME="$HOME" USER="${USER:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="${TMPDIR:-/tmp}" SUPLEX_DESKTOP_USER_DATA="$scratch/app" "$app/Contents/MacOS/Suplex" --url "http://127.0.0.1:$port/packaged" >"$scratch/app.log" 2>&1 &
  shell=$!
  waited=0
  until grep -q "^/packaged" "$scratch/host/data/fixture-requests.log" 2>/dev/null || [ $waited -ge 30 ]; do sleep 1; waited=$((waited + 1)); done
  check "packaged app loads the requested host page" 'grep -q "^/packaged" "$scratch/host/data/fixture-requests.log" 2>/dev/null'
  check "packaged app remembers only the origin" 'grep -q "\"targets\":\[\"http://127.0.0.1:$port/\"\]" "$scratch/app/desktop.json" 2>/dev/null'
  kill -TERM "$shell" 2>/dev/null || true
  waited=0
  while kill -0 "$shell" 2>/dev/null && [ $waited -lt 15 ]; do sleep 1; waited=$((waited + 1)); done
  check "packaged app exits on SIGTERM" '! kill -0 "$shell" 2>/dev/null'
  kill -KILL "$shell" 2>/dev/null || true
  kill "$host" 2>/dev/null || true
  rm -rf "$scratch"
else
  echo "note launch check skipped: this Mac cannot run $machine code natively"
fi

[ $failures = 0 ] || { echo "$failures packaged check(s) failed" >&2; exit 1; }
echo "Packaged checks passed for $release"
