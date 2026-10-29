# Sourced by the Linux build scripts. Docker on Apple silicon runs x64 builds under slow emulation, so an x64
# build runs on SUPLEX_BUILD_HOST (an SSH destination for a native x64 machine, set in mise.local.toml) when it
# answers, and here otherwise. Without SUPLEX_BUILD_HOST it always builds here. The checkout and its Git directory are mirrored
# to the same absolute paths there, so the scripts' bind mounts work unchanged through DOCKER_HOST.

# Sets builder to the build host for this architecture, or to nothing for a local build.
linux_builder() {
  builder=""
  [ "$1" = x64 ] && [ "$(uname -m)" != x86_64 ] || return 0
  host="${SUPLEX_BUILD_HOST-}"
  [ -n "$host" ] || return 0
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" 'uname -m | grep -qx x86_64 && docker info' >/dev/null 2>&1; then
    builder="$host"
    echo "Building Linux x64 on $builder"
  else
    echo "$host is not available; building Linux x64 here under emulation"
  fi
}

# Runs docker on the build host, or here.
dock() {
  if [ -n "$builder" ]; then DOCKER_HOST="ssh://$builder" docker "$@"; else docker "$@"; fi
}

# Copies the checkout (or one folder of it, $1) to the build host. Build outputs and caches stay out of it.
builder_push() {
  [ -n "$builder" ] || return 0
  src="$PWD${1:+/$1}"
  ssh "$builder" mkdir -p "'$src'"
  rsync -a --delete -e ssh --exclude node_modules --exclude /target --exclude /dist --exclude /apps/desktop/release \
    --exclude /apps/desktop/.build "$src/" "$builder:$src/"
  common="$(git rev-parse --path-format=absolute --git-common-dir)"
  case "$common/" in "$PWD"/*) ;; *) [ -n "${1:-}" ] || { ssh "$builder" mkdir -p "'$common'"; rsync -a --delete -e ssh "$common/" "$builder:$common/"; } ;; esac
}

# Copies a folder ($1) of build output back from the build host.
builder_pull() {
  [ -n "$builder" ] || return 0
  mkdir -p "$1"
  rsync -a --delete -e ssh "$builder:$PWD/$1/" "$1/"
}
