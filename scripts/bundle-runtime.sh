#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

pinned=$(sed -n 's/^node = "\(.*\)"$/\1/p' mise.toml)
node_root=$(mise where node)
[ "$("$node_root/bin/node" --version)" = "v$pinned" ] || {
  echo "mise node is $("$node_root/bin/node" --version), not the pinned v$pinned; the bundled better_sqlite3.node would not match" >&2
  exit 1
}

# The deploy below marks this workspace's node_modules as a production install, after which the next
# root pnpm command offers to purge it. These two installs put the dev install back; the first covers
# a previous run that was interrupted before the second.
pnpm install --frozen-lockfile
pnpm build

rm -rf desktop/runtime
mkdir -p desktop/runtime/node/bin
cp "$node_root/bin/node" desktop/runtime/node/bin/node

# --legacy: this workspace does not set inject-workspace-packages, which pnpm 10+ now requires for the default deploy.
pnpm --filter=forge deploy --prod --legacy desktop/runtime/app
rm -rf desktop/runtime/app/dist/tests desktop/runtime/app/dist/scripts

pnpm install --frozen-lockfile
