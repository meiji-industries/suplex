#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
case "$arch" in
  arm64) target=aarch64-apple-darwin; machine=arm64 ;;
  x64) target=x86_64-apple-darwin; machine=x86_64 ;;
  *) echo "SUPLEX_DESKTOP_ARCH must be arm64 or x64, not $arch" >&2; exit 1 ;;
esac

pnpm exec vite build
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
