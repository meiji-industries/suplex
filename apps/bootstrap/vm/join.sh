# Phase 1, over the public IP as the admin user: install Tailscale and join. Env: TS_AUTHKEY, TS_HOSTNAME, EXIT_NODE.
set -e
# A fresh cloud image runs apt on first boot (cloud-init, unattended upgrades); wait for it rather than lose the lock.
if ! command -v tailscale >/dev/null; then
  command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
    sleep 3
  done
  curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale status >/dev/null 2>&1 || tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --ssh --accept-dns
tailscale set --hostname="$TS_HOSTNAME" --ssh
# The exit node reroutes replies to this public-IP session, so set it after we hang up.
if [ -n "$EXIT_NODE" ]; then
  nohup sh -c "sleep 2; tailscale set --exit-node='$EXIT_NODE' --exit-node-allow-lan-access=false" >/dev/null 2>&1 &
fi
# The name this node actually got; Tailscale appends -1 when the tailnet still holds the hostname (an old VM).
echo "SUPLEX_VM_NODE=$(tailscale status --self --json | grep -m1 -o '"DNSName": *"[^"]*' | sed 's/.*"//; s/\..*//')"
