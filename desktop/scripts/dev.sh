#!/bin/sh
# Runs the desktop app from source. TypeScript recompiles and pages/*.html|css recopy on save:
# press Cmd+R for page edits; quit and rerun for main-process or preload edits.
set -eu
cd "$(dirname "$0")/.."

# `electron .` shows "Electron" in the menu bar and Cmd+Tab (macOS reads the bundle's plist).
# Launch an APFS clone renamed to Suplex; never edit node_modules, pnpm hardlinks it to the store.
stock="$(dirname "$(dirname "$(dirname "$(node -p "require('electron')")")")")"
app=.electron-dev/Suplex.app
if [ ! -d "$app" ] || [ "$(cat .electron-dev/source 2>/dev/null)" != "$stock" ]; then
  rm -rf .electron-dev && mkdir .electron-dev
  cp -Rc "$stock" "$app"
  plutil -replace CFBundleName -string Suplex "$app/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string Suplex "$app/Contents/Info.plist"
  echo "$stock" > .electron-dev/source
fi

# Packaged builds carry the runtime in Contents/Resources/runtime. Dev runs the checkout with the pinned
# node instead (see runtimePaths in src/boot.ts), so "Run locally" runs the current server code, and keeps
# its data, single-instance lock, and port apart from the installed Suplex.app.
node_bin="$(mise where node)/bin/node"  # the pinned node, as scripts/bundle-runtime.sh bundles
(cd .. && PATH="$(dirname "$node_bin"):$PATH" pnpm build)
export SUPLEX_DESKTOP_NODE="${SUPLEX_DESKTOP_NODE:-$node_bin}"
export SUPLEX_DESKTOP_APP="${SUPLEX_DESKTOP_APP:-$(cd .. && pwd)}"
export SUPLEX_DESKTOP_USER_DATA="${SUPLEX_DESKTOP_USER_DATA:-$HOME/Library/Application Support/Suplex Dev}"
export SUPLEX_DESKTOP_PORT="${SUPLEX_DESKTOP_PORT:-4121}"

pnpm build
trap 'kill 0' EXIT INT TERM
tsc -p tsconfig.json --watch --preserveWatchOutput &
node -e '
const { watch, copyFileSync } = require("node:fs");
watch("src", { recursive: true }, (_, file) => {
  if (!file || !/\.(html|css|png|svg)$/.test(file)) return;
  try { copyFileSync(`src/${file}`, `dist/src/${file}`); console.log(`copied ${file}`); } catch {}
});' &
"$app/Contents/MacOS/Electron" .
