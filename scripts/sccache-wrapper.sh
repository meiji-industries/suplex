#!/bin/sh
# Backwards-compatible shim for scripts/sccache.sh.
# Point RUSTC_WRAPPER at scripts/sccache.sh so cc-rs sees file_stem == "sccache"
# and automatically caches C/C++ native crates alongside rustc.
script_dir="${0%/*}"
[ "$script_dir" = "$0" ] && script_dir="."
exec "$script_dir/sccache.sh" "$@"
