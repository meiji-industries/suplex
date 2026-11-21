#!/usr/bin/env bash
# Reclaim Rust build-artifact bloat across this repo and all linked worktrees.
#
# Why this script exists instead of calling `cargo sweep` alone:
#   1. `cargo-sweep` never touches `target/*/incremental/`. Incremental caches
#      grow across feature/profile hashes, which causes `cargo sweep --maxsize`
#      to evict warm `debug/deps/` artifacts while leaving `incremental/` behind.
#   2. Worktrees can live outside one folder (`git worktree list` plus any
#      workspace directories under `$HOME/conductor/workspaces/suplex`).
set -euo pipefail

MAXSIZE="${MAXSIZE:-6GB}"
CURRENT_ONLY=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/clean-target.sh [OPTIONS]

Options:
  --maxsize <SIZE>   Target size cap passed to cargo-sweep (default: $MAXSIZE or 6GB)
  --current-only     Only sweep the current worktree's target/ directory
  --dry-run          Report what would be cleaned without deleting files
  -h, --help         Show this help text
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --maxsize)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Error: --maxsize requires a value" >&2
        exit 2
      fi
      MAXSIZE="$1"
      ;;
    --current-only)
      CURRENT_ONLY=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

canonical_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 1
  (cd "$dir" 2>/dev/null && pwd -P)
}

collect_worktrees() {
  local current_root=""
  if current_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    canonical_dir "$current_root" || true
  else
    canonical_dir "$(pwd)" || true
  fi

  if [ "$CURRENT_ONLY" -eq 1 ]; then
    return
  fi

  if git rev-parse --git-dir >/dev/null 2>&1; then
    while IFS= read -r line; do
      case "$line" in
        worktree\ *)
          canonical_dir "${line#worktree }" || true
          ;;
      esac
    done < <(git worktree list --porcelain 2>/dev/null || true)
  fi

  local workspaces_dir="${SUPLEX_WORKSPACES_DIR:-$HOME/conductor/workspaces/suplex}"
  if [ -d "$workspaces_dir" ]; then
    local dir
    for dir in "$workspaces_dir"/*/; do
      [ -e "$dir" ] || continue
      [ -L "${dir%/}" ] && continue
      canonical_dir "$dir" || true
    done
  fi
}

prune_incremental_dirs() {
  local target_dir="$1"
  local inc_dir

  # Match both target/<profile>/incremental and target/<triple>/<profile>/incremental.
  while IFS= read -r inc_dir; do
    [ -d "$inc_dir" ] || continue
    local inc_size
    inc_size="$(du -sh "$inc_dir" 2>/dev/null | cut -f1)"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  [dry-run] would remove ${inc_dir#"$target_dir/"} (${inc_size})"
    else
      echo "  pruning ${inc_dir#"$target_dir/"} (${inc_size})"
      rm -rf "$inc_dir"
    fi
  done < <(find "$target_dir" -maxdepth 3 -type d -name incremental 2>/dev/null | sort)
}

free_kib() {
  df -k . | awk 'NR==2{print $4}'
}

main() {
  local has_sweep=0
  if command -v cargo-sweep >/dev/null 2>&1; then
    has_sweep=1
  else
    echo "⚠  cargo-sweep not found (incremental caches will still be pruned). Install: cargo install cargo-sweep"
  fi

  local before_kib
  before_kib="$(free_kib)"

  local seen_file
  seen_file="$(mktemp)"
  trap 'rm -f "${seen_file:-}"' EXIT

  local swept=0
  local wt
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    if grep -Fxq "$wt" "$seen_file" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$wt" >>"$seen_file"

    local target_dir="$wt/target"
    [ -d "$target_dir" ] || continue

    swept=$((swept + 1))
    local before_size
    before_size="$(du -sh "$target_dir" 2>/dev/null | cut -f1)"
    echo "Sweeping $wt (target/ is $before_size, capping at ${MAXSIZE})..."

    prune_incremental_dirs "$target_dir"

    if [ "$has_sweep" -eq 1 ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        (cd "$wt" && cargo sweep --dry-run --maxsize "$MAXSIZE" 2>&1 | tail -2 | sed 's/^/  /') || true
      else
        (cd "$wt" && cargo sweep --maxsize "$MAXSIZE" 2>&1 | tail -2 | sed 's/^/  /') || true
      fi
    fi

    if [ "$DRY_RUN" -eq 0 ]; then
      local after_size
      after_size="$(du -sh "$target_dir" 2>/dev/null | cut -f1)"
      echo "  now $after_size"
    fi
  done < <(collect_worktrees)

  if [ "$swept" -eq 0 ]; then
    echo "No target/ directories found."
    return
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    local after_kib
    after_kib="$(free_kib)"
    awk -v b="$before_kib" -v a="$after_kib" \
      'BEGIN{printf "\nReclaimed %.1f GB. %.0f GB now available.\n", (a-b)/1048576, a/1048576}'
  fi
  echo "A worktree you are done with: rm -rf <worktree>/target reclaims all of it."
}

main "$@"
