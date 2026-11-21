#!/bin/sh
# Wrapper around sccache for both rustc (RUSTC_WRAPPER) and C/C++ builds
# (cc-rs auto-detects RUSTC_WRAPPER only when the file stem is literally
# "sccache", and CMake uses this via CMAKE_{C,CXX}_COMPILER_LAUNCHER).

# Cargo has already translated the profile into rustc flags. Keep local
# incremental state in rustc; sccache can still cache registry dependencies.
for argument in "$@"; do
    case "$argument" in
        incremental=*|-Cincremental=*) exec "$@" ;;
    esac
done

# sccache rejects CARGO_INCREMENTAL even for non-incremental dependencies, and
# hashes CARGO_TARGET_DIR into Rust cache keys which prevents reuse across
# worktrees when a caller exports a per-worktree target path.
unset CARGO_INCREMENTAL
unset CARGO_TARGET_DIR

if sccache_path=$(command -v sccache 2>/dev/null); then
    : "${SCCACHE_CACHE_SIZE:=20G}"
    export SCCACHE_CACHE_SIZE
    # Long per-worktree TMPDIR values can exceed the macOS Unix socket path limit.
    TMPDIR=/tmp exec "$sccache_path" "$@"
fi

exec "$@"
