#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# SUPLEX_DESKTOP_ARCH picks the Mac the runtime is for: arm64 (Apple silicon, the default) or x64 (Intel).
arch="${SUPLEX_DESKTOP_ARCH:-arm64}"
case "$arch" in
  arm64) machine=arm64 ;;
  x64) machine=x86_64 ;;
  *) echo "SUPLEX_DESKTOP_ARCH must be arm64 or x64, not $arch" >&2; exit 1 ;;
esac

pinned=$(sed -n 's/^node = "\(.*\)"$/\1/p' mise.toml)
node_root=$(mise where node)
[ "$("$node_root/bin/node" --version)" = "v$pinned" ] || {
  echo "mise node is $("$node_root/bin/node" --version), not the pinned v$pinned; the bundled better_sqlite3.node would not match" >&2
  exit 1
}

# `mise run` hands its tasks whatever node is first on PATH, which is not always the pinned one.
# Every pnpm command below has to see the pinned node or the native modules it installs get the wrong ABI.
PATH="$node_root/bin:$PATH"
export PATH

# The deploy below marks this workspace's node_modules as a production install, after which the next
# root pnpm command offers to purge it. These two installs put the dev install back; the first covers
# a previous run that was interrupted before the second.
pnpm install --frozen-lockfile
pnpm build

rm -rf desktop/runtime
mkdir -p desktop/runtime/node/bin
if [ "$arch" = arm64 ]; then
  cp "$node_root/bin/node" desktop/runtime/node/bin/node
else
  # The pinned node for the other architecture, checked against nodejs.org's published checksums.
  dist="node-v$pinned-darwin-$arch"
  download=$(mktemp -d)
  trap 'rm -rf "$download"' EXIT
  curl -fsSL -o "$download/$dist.tar.gz" "https://nodejs.org/dist/v$pinned/$dist.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$pinned/SHASUMS256.txt" | grep " $dist.tar.gz\$" | (cd "$download" && shasum -a 256 -c -)
  tar -xzf "$download/$dist.tar.gz" -C "$download" "$dist/bin/node"
  cp "$download/$dist/bin/node" desktop/runtime/node/bin/node
fi

# --legacy: this workspace does not set inject-workspace-packages, which pnpm 10+ now requires for the default deploy.
pnpm --filter=suplex deploy --prod --legacy desktop/runtime/app
rm -rf desktop/runtime/app/dist/tests desktop/runtime/app/dist/scripts

# The deploy installed better-sqlite3 for this Mac; replace it with the build for the target architecture.
sqlite=desktop/runtime/app/node_modules/better-sqlite3
if [ "$arch" != arm64 ]; then
  (cd "$sqlite" && npx --yes node-gyp@11 rebuild --release --arch="$arch" --target="$pinned" >/dev/null)
fi
for binary in desktop/runtime/node/bin/node "$sqlite/build/Release/better_sqlite3.node"; do
  file "$binary" | grep -q "$machine" || { echo "$binary is not built for $machine: $(file -b "$binary")" >&2; exit 1; }
done

pnpm install --frozen-lockfile
