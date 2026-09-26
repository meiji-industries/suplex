#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-serve}" in
  start|restart|serve) pnpm exec vite build ;;
esac
cd rust
unset RUSTUP_TOOLCHAIN
cargo build --quiet --bin suplex
binary="${CARGO_TARGET_DIR:-$PWD/target}/debug/suplex"
case "$binary" in /*) ;; *) binary="$PWD/$binary" ;; esac
cd ..
exec "$binary" "$@"
