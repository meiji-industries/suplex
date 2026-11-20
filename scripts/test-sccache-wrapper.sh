#!/bin/sh
set -eu

wrapper="$(pwd)/scripts/sccache.sh"
shim="$(pwd)/scripts/sccache-wrapper.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

wrapper_base="$(basename "$wrapper")"
[ "${wrapper_base%.*}" = "sccache" ] || {
    echo "Expected wrapper file stem 'sccache' for cc-rs auto-detection, got: $wrapper_base" >&2
    exit 1
}

cat > "$scratch/compiler" <<'SH'
#!/bin/sh
[ "$#" = 1 ] && [ "$1" = 'argument with spaces' ] || exit 1
exit 42
SH
cat > "$scratch/sccache" <<'SH'
#!/bin/sh
[ "$TMPDIR" = /tmp ] || exit 1
[ -z "${CARGO_INCREMENTAL+x}" ] || exit 1
[ -z "${CARGO_TARGET_DIR+x}" ] || exit 1
[ -n "${SCCACHE_CACHE_SIZE:-}" ] || exit 1
exec "$@"
SH
chmod +x "$scratch/compiler" "$scratch/sccache"

# Both the primary wrapper and legacy shim must preserve arguments, strip
# CARGO_INCREMENTAL / CARGO_TARGET_DIR, and propagate compiler exit status.
for candidate in "$wrapper" "$shim"; do
    for cache_path in "$scratch" ''; do
        result=0
        PATH="$cache_path" TMPDIR=/a/long/worktree/temp/path \
            CARGO_INCREMENTAL=1 CARGO_TARGET_DIR=/tmp/worktree-a/target \
            "$candidate" "$scratch/compiler" 'argument with spaces' || result=$?
        [ "$result" = 42 ]
    done
done

# Incremental rustc invocations must bypass the cache and keep exact arguments.
cat > "$scratch/compiler" <<'SH'
#!/bin/sh
[ "$CARGO_INCREMENTAL" = 1 ] || exit 1
case "$#:$1" in
    3:-C) [ "$2" = 'incremental=/a path/cache' ] && [ "$3" = 'argument with spaces' ] || exit 1 ;;
    2:-Cincremental=*) [ "$1" = '-Cincremental=/a path/cache' ] && [ "$2" = 'argument with spaces' ] || exit 1 ;;
    *) exit 1 ;;
esac
exit 42
SH
cat > "$scratch/sccache" <<'SH'
#!/bin/sh
exit 99
SH
result=0
PATH="$scratch" CARGO_INCREMENTAL=1 "$wrapper" "$scratch/compiler" -C 'incremental=/a path/cache' 'argument with spaces' || result=$?
[ "$result" = 42 ]
result=0
PATH="$scratch" CARGO_INCREMENTAL=1 "$wrapper" "$scratch/compiler" '-Cincremental=/a path/cache' 'argument with spaces' || result=$?
[ "$result" = 42 ]
echo "sccache wrapper checks passed"
