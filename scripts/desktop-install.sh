#!/bin/sh
# Build Suplex.app from this checkout and replace the installed app, without a release.
# The installation's data (~/Library/Application Support/Suplex) is untouched.
set -eu
cd "$(dirname "$0")/.."

destination="${SUPLEX_INSTALL_PATH:-/Applications/Suplex.app}"

if [ "${SUPLEX_INSTALL_DIRTY:-}" != 1 ] && ! { git diff --quiet && git diff --cached --quiet; }; then
  echo "This checkout has uncommitted changes. Commit or stash them, or set SUPLEX_INSTALL_DIRTY=1 to build them anyway." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac
export SUPLEX_DESKTOP_ARCH="${SUPLEX_DESKTOP_ARCH:-$arch}"

echo "Building Suplex.app ($SUPLEX_DESKTOP_ARCH) at $(git rev-parse --short HEAD)"
pnpm run desktop:dist

built="$(find "desktop/release/$SUPLEX_DESKTOP_ARCH" -maxdepth 2 -name Suplex.app -type d | head -n 1)"
if [ -z "$built" ]; then
  echo "desktop:dist produced no Suplex.app under desktop/release/$SUPLEX_DESKTOP_ARCH" >&2
  exit 1
fi

# Quitting the app stops its server; running tasks resume after relaunch.
# Wait only for the app and its server. Agent sessions keep `suplex mcp` and
# `suplex display` helpers from the bundle running; they continue on the old binary.
app_processes="^$destination/Contents/(MacOS/|Resources/runtime/bin/suplex start)"
if pgrep -f "$app_processes" >/dev/null 2>&1; then
  echo "Quitting the running Suplex"
  osascript -e 'tell application "Suplex" to quit' >/dev/null 2>&1 || true
  waited=0
  while pgrep -f "$app_processes" >/dev/null 2>&1; do
    if [ "$waited" -ge 60 ]; then
      echo "Suplex is still running after 60 seconds; quit it and run this again." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

backup=""
if [ -e "$destination" ]; then
  backup="$(mktemp -d)/Suplex.app"
  mv "$destination" "$backup"
fi
if ! ditto "$built" "$destination"; then
  echo "Copying the new app failed; restoring the previous one." >&2
  rm -rf "$destination"
  [ -n "$backup" ] && mv "$backup" "$destination"
  exit 1
fi
[ -n "$backup" ] && rm -rf "$(dirname "$backup")"

echo "Installed $destination; relaunching"
open "$destination"
"$destination/Contents/Resources/runtime/bin/suplex" doctor
