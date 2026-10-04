#!/bin/sh
# Native macOS smoke tests: the real app binary in WKWebView, built with the test-only driver feature,
# with its own bundle identifier, data directories, and fixture hosts. Never touches an installed app.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "The native smoke suite runs on macOS only." >&2; exit 1; }
unset RUSTUP_TOOLCHAIN
export TAURI_CONFIG='{"identifier":"dev.suplex.desktop.test"}'
export CARGO_TARGET_DIR="${SUPLEX_NATIVE_TARGET_DIR:-$PWD/src-tauri/target/native-test}"
cargo test --manifest-path src-tauri/Cargo.toml --features native-test --test native_smoke -- --test-threads=1 --nocapture "$@"
