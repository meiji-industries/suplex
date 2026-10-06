#!/bin/sh
# Builds the host binary the desktop app bundles, for this OS and SUPLEX_DESKTOP_ARCH, into desktop/runtime.
# SUPLEX_SKIP_WEB_BUILD=1 reuses dist/web: the Linux container has no node_modules and gets it built by the Mac.
set -eu
cd "$(dirname "$0")/.."

arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
case "$(uname -s):$arch" in
  Darwin:arm64) target=aarch64-apple-darwin; machine=arm64 ;;
  Darwin:x64) target=x86_64-apple-darwin; machine=x86_64 ;;
  Linux:arm64) target=aarch64-unknown-linux-gnu; machine=aarch64 ;;
  Linux:x64) target=x86_64-unknown-linux-gnu; machine=x86-64 ;;
  *) echo "SUPLEX_DESKTOP_ARCH must be arm64 or x64 on macOS or Linux, not $arch on $(uname -s)" >&2; exit 1 ;;
esac

if [ -z "${SUPLEX_SKIP_WEB_BUILD:-}" ]; then
  pnpm exec vite build
fi
[ -f dist/web/suplex-ui.js ] || { echo "dist/web is not built; run pnpm exec vite build first" >&2; exit 1; }
unset RUSTUP_TOOLCHAIN
(cd rust && cargo build --release --target "$target" --bin suplex)

target_dir="${CARGO_TARGET_DIR:-target}"
case "$target_dir" in /*) ;; *) target_dir="$PWD/rust/$target_dir" ;; esac
binary="$target_dir/$target/release/suplex"
file "$binary" | grep -q "$machine" || { echo "$binary is not built for $machine: $(file -b "$binary")" >&2; exit 1; }
rm -rf desktop/runtime
mkdir -p desktop/runtime/bin
cp "$binary" desktop/runtime/bin/suplex
node -e 'const fs = require("node:fs"); fs.writeFileSync("desktop/runtime/manifest.json", JSON.stringify({ version: require("./desktop/package.json").version }))'
