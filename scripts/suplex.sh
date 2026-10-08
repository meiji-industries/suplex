#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  start|up|restart|serve) pnpm --filter suplex-web build ;;
esac
unset RUSTUP_TOOLCHAIN
cargo build --quiet -p suplex --bin suplex
binary="${CARGO_TARGET_DIR:-$PWD/target}/debug/suplex"
case "$binary" in /*) ;; *) binary="$PWD/$binary" ;; esac
exec "$binary" "$@"
