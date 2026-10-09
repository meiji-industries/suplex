#!/bin/sh
# Builds suplex-bootstrap for macOS and Linux, arm64 and x64, and packs each under dist/bootstrap/<platform>/:
# suplex-bootstrap-<version>-<platform>.tar.gz, its .sha256, and latest.yml. The version is the one in
# apps/bootstrap/Cargo.toml. The Mac binaries are signed with the Developer ID (APPLE_SIGNING_IDENTITY overrides);
# Linux builds in Docker on Debian bullseye like scripts/build-linux.sh, so it runs on glibc 2.31 and newer.
set -eu
cd "$(dirname "$0")/.."
unset RUSTUP_TOOLCHAIN

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' apps/bootstrap/Cargo.toml | head -n 1)"
target="${CARGO_TARGET_DIR:-$PWD/target}"
rm -rf dist/bootstrap

# Packs dist/bootstrap/$1/suplex-bootstrap.
pack() {
  out="dist/bootstrap/$1"
  tarball="suplex-bootstrap-$version-$1.tar.gz"
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$out" -czf "$out/$tarball" suplex-bootstrap
  rm "$out/suplex-bootstrap"
  sha="$(shasum -a 256 "$out/$tarball" | cut -d' ' -f1)"
  printf '%s  %s\n' "$sha" "$tarball" > "$out/$tarball.sha256"
  printf 'version: %s\nfiles:\n  - url: %s\n    sha256: %s\n' "$version" "$tarball" "$sha" > "$out/latest.yml"
  echo "Built $out/$tarball"
}

for arch in arm64 x64; do
  triple="$([ "$arch" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)"
  cargo build --release --locked -p suplex-bootstrap --target "$triple"
  mkdir -p "dist/bootstrap/macos-$arch"
  cp "$target/$triple/release/suplex-bootstrap" "dist/bootstrap/macos-$arch/"
  codesign --force --timestamp --options runtime --sign "${APPLE_SIGNING_IDENTITY:-Developer ID Application}" "dist/bootstrap/macos-$arch/suplex-bootstrap"
  pack "macos-$arch"
done

. scripts/linux-builder.sh
for arch in arm64 x64; do
  platform="$([ "$arch" = arm64 ] && echo linux/arm64 || echo linux/amd64)"
  out="dist/bootstrap/linux-$arch"
  linux_builder "$arch"
  builder_push
  dock run --rm --platform "$platform" \
    -v "$PWD:$PWD" -v "suplex-linux-target-$arch:/target" -v "suplex-linux-cargo-$arch:/usr/local/cargo/registry" \
    -w "$PWD" -e CARGO_TARGET_DIR=/target -e RUSTUP_TOOLCHAIN=1.93.1 \
    rust:1.93.1-bullseye \
    sh -c "cargo build --release --locked -p suplex-bootstrap && mkdir -p '$PWD/$out' && cp /target/release/suplex-bootstrap '$PWD/$out/'"
  builder_pull "$out"
  file "$out/suplex-bootstrap" | grep -q "$( [ "$arch" = arm64 ] && echo aarch64 || echo x86-64 )" || { echo "$out/suplex-bootstrap is not a Linux $arch binary: $(file -b "$out/suplex-bootstrap")" >&2; exit 1; }
  pack "linux-$arch"
done
