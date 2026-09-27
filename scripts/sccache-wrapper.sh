#!/bin/sh

if sccache_path=$(command -v sccache 2>/dev/null); then
    # Conductor's TMPDIR can exceed the macOS Unix socket path limit.
    TMPDIR=/tmp exec "$sccache_path" "$@"
fi

exec "$@"
