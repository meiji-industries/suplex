#!/usr/bin/env bash
# Regression tests for scripts/clean-target.sh.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/clean-target.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_prunes_incremental_before_cargo_sweep() {
  local tmp_dir repo_dir bin_dir log_file
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  repo_dir="$tmp_dir/repo"
  bin_dir="$tmp_dir/bin"
  log_file="$tmp_dir/sweep.log"
  mkdir -p "$repo_dir/target/debug/incremental/suplex-abc"
  mkdir -p "$repo_dir/target/aarch64-apple-darwin/debug/incremental/suplex-def"
  mkdir -p "$repo_dir/target/debug/deps"
  mkdir -p "$bin_dir"
  printf 'inc-blob' >"$repo_dir/target/debug/incremental/suplex-abc/dep-graph.bin"
  printf 'inc-blob' >"$repo_dir/target/aarch64-apple-darwin/debug/incremental/suplex-def/dep-graph.bin"
  printf 'warm-dep' >"$repo_dir/target/debug/deps/libfoo.rlib"

  cat >"$bin_dir/cargo-sweep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"$bin_dir/cargo" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "sweep" ]; then
  if [ -d target/debug/incremental ]; then
    echo "INCREMENTAL_STILL_PRESENT" >>"$log_file"
    exit 1
  fi
  echo "SWEEP_CALLED \$*" >>"$log_file"
  exit 0
fi
exit 0
EOF
  chmod +x "$bin_dir/cargo-sweep" "$bin_dir/cargo"

  (
    cd "$repo_dir"
    PATH="$bin_dir:$PATH" SUPLEX_WORKSPACES_DIR="$tmp_dir/none" \
      bash "$SCRIPT" --current-only --maxsize 4GB >/dev/null
  )

  [ ! -d "$repo_dir/target/debug/incremental" ] ||
    fail "target/debug/incremental was not pruned"
  [ ! -d "$repo_dir/target/aarch64-apple-darwin/debug/incremental" ] ||
    fail "target/<triple>/debug/incremental was not pruned"
  [ -f "$repo_dir/target/debug/deps/libfoo.rlib" ] ||
    fail "warm debug/deps artifact was unexpectedly removed"
  grep -q "SWEEP_CALLED sweep --maxsize 4GB" "$log_file" ||
    fail "cargo sweep was not invoked with --maxsize 4GB after pruning incremental/"
}

test_dry_run_preserves_incremental() {
  local tmp_dir repo_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  repo_dir="$tmp_dir/repo"
  mkdir -p "$repo_dir/target/debug/incremental/suplex-abc"
  printf 'inc-blob' >"$repo_dir/target/debug/incremental/suplex-abc/dep-graph.bin"

  (
    cd "$repo_dir"
    SUPLEX_WORKSPACES_DIR="$tmp_dir/none" \
      bash "$SCRIPT" --current-only --dry-run >/dev/null
  )

  [ -f "$repo_dir/target/debug/incremental/suplex-abc/dep-graph.bin" ] ||
    fail "--dry-run deleted incremental cache"
}

test_prunes_incremental_before_cargo_sweep
test_dry_run_preserves_incremental
echo "clean-target tests passed"
