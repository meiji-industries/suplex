#!/bin/sh
set -eu

tailscale_command="${FORGE_TAILSCALE_COMMAND:-tailscale}"
macos_tailscale_command="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

if [ "$tailscale_command" = "tailscale" ] && [ -x "$macos_tailscale_command" ]; then
  tailscale_command="$macos_tailscale_command"
fi

if ! tailscale_status=$("$tailscale_command" status --json 2>/dev/null); then
  printf '%s\n' "${FORGE_TAILSCALE_ADDRESS:-}"
  exit 0
fi

printf '%s\n' "$tailscale_status" \
  | jq -er '.Self.DNSName | strings | rtrimstr(".") | select(endswith(".ts.net"))'
