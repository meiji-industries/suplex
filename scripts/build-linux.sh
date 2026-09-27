#!/bin/sh
# Builds the suplex binary for Linux in Docker and packs dist/linux/<arch>/suplex-<version>-linux-<arch>.tar.gz,
# its .sha256, and latest-linux.yml (SUPLEX_LINUX_ARCH=arm64 or x64, default arm64).
# Debian bullseye's glibc 2.31 lets the binary run on Debian 11, Ubuntu 20.04, and newer.
set -eu
cd "$(dirname "$0")/.."

arch="${SUPLEX_LINUX_ARCH:-arm64}"
case "$arch" in
  arm64) platform=linux/arm64 ;;
  x64) platform=linux/amd64 ;;
  *) echo "SUPLEX_LINUX_ARCH must be arm64 or x64, not $arch" >&2; exit 1 ;;
esac

version="$(node -p "require('./package.json').version")"
out="dist/linux/$arch"
tarball="suplex-$version-linux-$arch.tar.gz"
pnpm exec vite build
rm -rf "$out"
mkdir -p "$out"

# The checkout and its Git directory keep their host paths, so build.rs can stamp the revision.
common="$(git rev-parse --path-format=absolute --git-common-dir)"
docker run --rm --platform "$platform" \
  -v "$PWD:$PWD" -v "$common:$common:ro" \
  -v "suplex-linux-target-$arch:/target" -v "suplex-linux-cargo-$arch:/usr/local/cargo/registry" \
  -w "$PWD/rust" -e CARGO_TARGET_DIR=/target -e RUSTUP_TOOLCHAIN=1.93.1 \
  rust:1.93.1-bullseye \
  sh -c "git config --global --add safe.directory '*' && cargo build --release --locked --bin suplex && cp /target/release/suplex '$PWD/$out/suplex'"

file "$out/suplex" | grep -q "$( [ "$arch" = arm64 ] && echo aarch64 || echo x86-64 )" || { echo "$out/suplex is not a Linux $arch binary: $(file -b "$out/suplex")" >&2; exit 1; }
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$out" -czf "$out/$tarball" suplex
rm "$out/suplex"
sha="$(shasum -a 256 "$out/$tarball" | cut -d' ' -f1)"
printf '%s  %s\n' "$sha" "$tarball" > "$out/$tarball.sha256"
printf 'version: %s\nfiles:\n  - url: %s\n    sha256: %s\n' "$version" "$tarball" "$sha" > "$out/latest-linux.yml"
echo "Built $out/$tarball"
