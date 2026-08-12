#!/bin/sh
set -eu

tailscale_command="${FORGE_TAILSCALE_COMMAND:-tailscale}"
macos_tailscale_command="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

if [ "$tailscale_command" = "tailscale" ] && [ -x "$macos_tailscale_command" ]; then
  tailscale_command="$macos_tailscale_command"
fi

"$tailscale_command" status --json \
  | jq -er '.Self.DNSName | strings | rtrimstr(".") | select(endswith(".ts.net"))'
