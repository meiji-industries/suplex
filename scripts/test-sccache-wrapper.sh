#!/bin/sh
set -eu

wrapper="$(pwd)/scripts/sccache-wrapper.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

cat > "$scratch/compiler" <<'SH'
#!/bin/sh
[ "$#" = 1 ] && [ "$1" = 'argument with spaces' ] || exit 1
exit 42
SH
cat > "$scratch/sccache" <<'SH'
#!/bin/sh
[ "$TMPDIR" = /tmp ] || exit 1
exec "$@"
SH
chmod +x "$scratch/compiler" "$scratch/sccache"

# Both paths must preserve arguments and the compiler's failure status.
for cache_path in "$scratch" ''; do
    result=0
    PATH="$cache_path" TMPDIR=/a/long/conductor/temp/path \
        "$wrapper" "$scratch/compiler" 'argument with spaces' || result=$?
    [ "$result" = 42 ]
done
echo "sccache wrapper checks passed"
