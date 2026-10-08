#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
pnpm --filter suplex-web build
unset RUSTUP_TOOLCHAIN
cargo build --release -p suplex --bin suplex
binary="${CARGO_TARGET_DIR:-target}/release/suplex"
if [ -n "${SUPLEX_CODESIGN_IDENTITY:-}" ]; then
  codesign --force --sign "$SUPLEX_CODESIGN_IDENTITY" "$binary"
fi
