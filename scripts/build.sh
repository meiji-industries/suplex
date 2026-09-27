#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
pnpm exec vite build
unset RUSTUP_TOOLCHAIN
cd rust
cargo build --release --bin suplex
binary="${CARGO_TARGET_DIR:-target}/release/suplex"
if [ -n "${SUPLEX_CODESIGN_IDENTITY:-}" ]; then
  codesign --force --sign "$SUPLEX_CODESIGN_IDENTITY" "$binary"
fi
