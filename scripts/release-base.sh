#!/bin/sh
# Prints the commit a release is built from, as the stamp that lets a rerun reuse its builds.
# A release build is HEAD plus the uncommitted version bump, so those files do not count as dirty.
# Once HEAD is this version's release commit, the stamp is its parent, which is what was built.
set -eu
top="$(git rev-parse --show-toplevel)"
# No node: dist-linux.sh runs this inside the Linux build container.
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$top/package.json")"
base="$(git rev-parse HEAD)"
if [ "$(git rev-parse -q --verify "refs/tags/v$version^{commit}" || true)" = "$base" ]; then
  base="$(git rev-parse HEAD^)"
fi
dirty="$(git -C "$top" status --porcelain -- . ':!package.json' ':!apps/desktop/package.json' ':!apps/mobile/package.json' ':!apps/server/Cargo.toml' ':!apps/desktop/src-tauri/Cargo.toml' ':!Cargo.lock')"
printf '%s%s\n' "$base" "$([ -z "$dirty" ] || echo -dirty)"
