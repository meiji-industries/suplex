#!/bin/zsh
# usage: scripts/dev-restart.sh [--force] <dev-pane-id>
# Restarts `mise run dev` in the given Herdr pane, only when no Temporal activity is in flight.
# Exit 1 = busy (nothing touched), exit 2 = pane did not come back healthy.
set -e
FORCE=0
[ "$1" = "--force" ] && { FORCE=1; shift; }
PANE="$1"; [ -n "$PANE" ] || { echo "usage: $0 [--force] <dev-pane-id>" >&2; exit 64; }
cd "$(dirname "$0")/.."
[ "$FORCE" = 1 ] || mise run dev:idle || exit 1
MARK="Worker startup: local deployment activated"
count() { herdr pane read "$1" --source recent-unwrapped --lines 2000 | grep -c "$MARK" || true; }
before=$(count "$PANE")
herdr pane send-keys "$PANE" C-c >/dev/null
sleep 2
herdr pane send-text "$PANE" $'mise run dev\n' >/dev/null
for i in {1..120}; do [ "$(count "$PANE")" -gt "$before" ] && break; sleep 1; done
[ "$(count "$PANE")" -gt "$before" ] || { echo "worker did not report ready" >&2; exit 2; }
for i in {1..30}; do curl -sf -o /dev/null "http://127.0.0.1:${CONDUCTOR_PORT:-4111}/api/health" && { echo "restarted: API + worker up"; exit 0; }; sleep 1; done
echo "API did not answer /api/health" >&2; exit 2
