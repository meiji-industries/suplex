#!/bin/sh

# Cargo has already translated the profile into rustc flags. Keep local
# incremental state in rustc; sccache can still cache registry dependencies.
for argument in "$@"; do
    case "$argument" in
        incremental=*|-Cincremental=*) exec "$@" ;;
    esac
done

# sccache rejects this Cargo override even for a non-incremental dependency.
unset CARGO_INCREMENTAL

if sccache_path=$(command -v sccache 2>/dev/null); then
    # Conductor's TMPDIR can exceed the macOS Unix socket path limit.
    TMPDIR=/tmp exec "$sccache_path" "$@"
fi

exec "$@"
