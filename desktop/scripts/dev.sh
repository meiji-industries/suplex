#!/bin/sh
# Runs the desktop app from source. TypeScript recompiles and pages/*.html|css recopy on save:
# press Cmd+R for page edits; quit and rerun for main-process or preload edits.
set -eu
cd "$(dirname "$0")/.."

# `electron .` shows "Electron" in the menu bar and Cmd+Tab (macOS reads the bundle's plist).
# Launch an APFS clone renamed to Suplex; never edit node_modules, pnpm hardlinks it to the store.
node -e "require('electron')" >&2  # first require downloads the binary and logs to stdout
stock="$(dirname "$(dirname "$(dirname "$(node -p "require('electron')")")")")"
app=.electron-dev/Suplex.app
if [ ! -d "$app" ] || [ "$(cat .electron-dev/source 2>/dev/null)" != "$stock" ]; then
  rm -rf .electron-dev && mkdir .electron-dev
  cp -Rc "$stock" "$app"
  plutil -replace CFBundleName -string Suplex "$app/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string Suplex "$app/Contents/Info.plist"
  echo "$stock" > .electron-dev/source
fi

# Dev uses the current native build and a local manifest. Its data, single-instance lock,
# and port stay apart from the installed Suplex.app.
(cd .. && pnpm exec vite build && (cd rust && unset RUSTUP_TOOLCHAIN && cargo build --bin suplex))
mkdir -p runtime
node -e 'const fs = require("node:fs"); fs.writeFileSync("runtime/manifest.json", JSON.stringify({ version: require("./package.json").version }))'
export SUPLEX_DESKTOP_RUNTIME="${SUPLEX_DESKTOP_RUNTIME:-$(pwd)/runtime}"
target_dir="${CARGO_TARGET_DIR:-target}"
case "$target_dir" in /*) ;; *) target_dir="$(cd .. && pwd)/rust/$target_dir" ;; esac
export SUPLEX_DESKTOP_BINARY="${SUPLEX_DESKTOP_BINARY:-$target_dir/debug/suplex}"
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
