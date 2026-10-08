#!/bin/sh
# Checks a built apps/desktop/release/linux-<arch>/ inside a clean Ubuntu 22.04 container, as root:
# scripts/build-desktop-linux.sh runs it with the release folder at /release and this folder at /scripts.
# Installs the deb with its dependencies, checks its files, then launches the app against a test server
# and quits it with SIGTERM.
set -eu
cd /release
version="$(sed -n 's/^version: //p' latest-linux-desktop.yml)"
deb="$(ls Suplex-*-linux-*.deb)"
rpm="$(ls Suplex-*-linux-*.rpm)"
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1" >&2; failures=$((failures + 1)); fi; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install --yes --no-install-recommends -qq "./$deb" xvfb xauth dbus dbus-x11 python3 rpm file binutils >/dev/null

check "deb version $version" '[ "$(dpkg-query -W -f "\${Version}" suplex)" = "$version" ]'
check "rpm version $version" '[ "$(rpm -qp --queryformat "%{VERSION}" "$rpm" 2>/dev/null)" = "$version" ]'
check "app at /usr/bin/Suplex" '[ -x /usr/bin/Suplex ]'
check "bundled host is executable" '[ -x /usr/lib/Suplex/runtime/bin/suplex ]'
check "bundled host is built for this machine" 'file /usr/lib/Suplex/runtime/bin/suplex | grep -q "$(uname -m | sed s/_/-/)"'
check "runtime manifest version $version" '[ "$(cat /usr/lib/Suplex/runtime/manifest.json)" = "{\"version\":\"$version\"}" ]'
check "host embeds the web client" 'strings /usr/lib/Suplex/runtime/bin/suplex | grep -q suplex-ui'
check "suplex:// registration" 'grep -qx "MimeType=x-scheme-handler/suplex" /usr/share/applications/Suplex.desktop'
check "no native test driver" '! grep -aq suplex-native-test-driver /usr/bin/Suplex'
check "deb update type compiled in" 'grep -aq __TAURI_BUNDLE_TYPE_VAR_DEB /usr/bin/Suplex'
if [ -f latest-tauri.json ]; then
  check "the app updates from this architecture's HTTPS feed" 'grep -qx "url: https://.*/linux/$(dpkg --print-architecture | sed "s/amd64/x64/")/" /usr/lib/Suplex/app-update.yml'
  check "latest-tauri.json names both packages and their signatures" 'python3 - "$version" <<PY
import json, sys
manifest = json.load(open("latest-tauri.json"))
assert manifest["version"] == sys.argv[1]
assert len(manifest["platforms"]) == 2
for key, entry in manifest["platforms"].items():
    name = entry["url"].rsplit("/", 1)[1]
    assert key.endswith("-" + name.rsplit(".", 1)[1]) and entry["url"].startswith("https://")
    assert entry["signature"] == open(name + ".sig").read().strip()
PY'
fi

# Launch with isolated data against a test server, as a user would from the menu.
scratch="$(mktemp -d)"
mkdir -p "$scratch/site"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
(cd "$scratch/site" && python3 -m http.server "$port" --bind 127.0.0.1 2>"$scratch/http.log" >/dev/null) &
server=$!
dbus-run-session -- xvfb-run -a env SUPLEX_DESKTOP_USER_DATA="$scratch/app" /usr/bin/Suplex --url "http://127.0.0.1:$port/packaged" >"$scratch/app.log" 2>&1 &
waited=0
until grep -q "GET /packaged" "$scratch/http.log" 2>/dev/null || [ $waited -ge 60 ]; do sleep 1; waited=$((waited + 1)); done
check "app loads the requested host page" 'grep -q "GET /packaged" "$scratch/http.log"'
check "app remembers only the origin" 'grep -q "\"targets\":\[\"http://127.0.0.1:$port/\"\]" "$scratch/app/desktop.json"'
pkill -TERM -x Suplex || true
waited=0
while pgrep -x Suplex >/dev/null && [ $waited -lt 15 ]; do sleep 1; waited=$((waited + 1)); done
check "app exits on SIGTERM" '! pgrep -x Suplex >/dev/null'
pkill -KILL -x Suplex 2>/dev/null || true
kill "$server" 2>/dev/null || true
if [ $failures != 0 ]; then
  echo "--- app log" >&2
  cat "$scratch/app.log" >&2
  echo "$failures packaged check(s) failed" >&2
  exit 1
fi
echo "Packaged checks passed for $deb"
