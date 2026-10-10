#!/bin/sh
# mise renders this into every command's environment, so it must never fail.
# Without a MagicDNS name (Tailscale stopped, logged out, or missing), print
# SUPLEX_TAILSCALE_ADDRESS, which may be empty.
set -u

tailscale_command="${SUPLEX_TAILSCALE_COMMAND:-tailscale}"
macos_tailscale_command="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

if [ "$tailscale_command" = "tailscale" ] && [ -x "$macos_tailscale_command" ]; then
  tailscale_command="$macos_tailscale_command"
fi

address=$("$tailscale_command" status --json 2>/dev/null \
  | jq -r '.Self.DNSName | strings | rtrimstr(".") | select(endswith(".ts.net"))' 2>/dev/null)

printf '%s\n' "${address:-${SUPLEX_TAILSCALE_ADDRESS:-}}"
