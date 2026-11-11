#!/bin/sh
# Cargo starts each test binary and each `cargo run` binary through this script
# (.cargo/config.toml). Inside a Suplex Worker, PATH starts with the Worker Git
# guard. The guard blocks the push, checkout, and worktree commands that test
# fixtures run in their temporary repositories. This script gives the binary the
# real Git, as tests/helpers/setup-git-environment.ts does for the TypeScript
# tests. Outside a Worker it changes nothing.
guard="${SUPLEX_GIT_GUARD_DIR:-}"
if [ -n "$guard" ]; then
  path=
  saved_ifs=$IFS
  IFS=:
  for entry in $PATH; do
    [ "$entry" = "$guard" ] || path="${path:+$path:}$entry"
  done
  IFS=$saved_ifs
  PATH=$path
  export PATH
  if [ -n "${SUPLEX_GIT_REAL_BIN:-}" ]; then
    SUPLEX_GIT_BIN=$SUPLEX_GIT_REAL_BIN
    export SUPLEX_GIT_BIN
  fi
fi
exec "$@"
