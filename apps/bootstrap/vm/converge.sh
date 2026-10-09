# Phase 2, over the tailnet as the admin user. Idempotent; rerun any time.
# Env: ACCESS (tailscale|cloudflare|local|all), EXPOSURE (serve|funnel), DOMAIN + CF_TUNNEL_TOKEN (cloudflare), EXIT_NODE (empty = no egress enforcement), SUPLEX_PORT,
# GIT_NAME, GIT_EMAIL, AGENT_TOOLS (claude-code codex devin opencode, or none), RESTORE (y = restore
# /tmp/suplex-bootstrap/backup.tar.gz). The units and firewall were written to /tmp/suplex-bootstrap by the caller.
# Root does provisioning only. Suplex and every agent run as the `suplex` user (Claude Code refuses
# --dangerously-skip-permissions as root).
set -e
T=/tmp/suplex-bootstrap
H=/home/suplex
DATA=$H/.local/share/Suplex
PORT=${SUPLEX_PORT:-4111}
ACCESS=${ACCESS:-tailscale}
step() { printf '\n\033[1;35m◆ %s\033[0m\n' "$*"; }
# Runs a command as the service user, from its home, with its tools on PATH.
AS="runuser -u suplex -- env HOME=$H PATH=$H/.local/bin:$H/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin"
as_suplex() { $AS bash -c "cd ~ && $1" </dev/null; }

step "service user"
id suplex >/dev/null 2>&1 || useradd -m -s /bin/bash suplex
install -d -m 755 -o suplex -g suplex $H/.local $H/.local/bin $H/.local/share $H/.config
install -d -m 700 -o suplex -g suplex $H/.ssh
# `ssh suplex@host` works with the keys that already log in as the admin user.
for k in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ "$k" = $H/.ssh/authorized_keys ] || [ ! -f "$k" ] || cat "$k"; done | sort -u > $H/.ssh/authorized_keys
chown suplex:suplex $H/.ssh/authorized_keys; chmod 600 $H/.ssh/authorized_keys
if [ "$ACCESS" = tailscale ]; then tailscale set --operator=suplex; echo "user suplex, tailscale operator"   # lets the service run `tailscale serve`
else echo "user suplex"; fi

if [ -n "$EXIT_NODE" ]; then
  step "egress firewall: everything leaves through $EXIT_NODE (default-deny off the tailnet)"
  install -m 644 $T/suplex-egress.nft /etc/suplex-egress.nft
  install -m 644 $T/suplex-egress.service /etc/systemd/system/suplex-egress.service
  install -d /etc/systemd/system/suplex.service.d
  printf '[Unit]\nRequires=suplex-egress.service\nAfter=suplex-egress.service\n' > /etc/systemd/system/suplex.service.d/egress.conf
  systemctl daemon-reload; systemctl enable suplex-egress.service >/dev/null 2>&1; systemctl restart suplex-egress.service
  echo "egress ip: $(curl -4 -sS --max-time 20 https://ifconfig.me || echo NONE)"
  WAN=$(ip -o -4 route show default | awk '{print $5; exit}')
  echo "direct $WAN: $(curl -4 -sS --max-time 5 --interface "$WAN" https://ifconfig.me 2>/dev/null || echo blocked)"
  # Exit nodes are usually IPv4-only: make apt and the resolver prefer IPv4.
  echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
  grep -q "^precedence ::ffff:0:0/96  100" /etc/gai.conf || echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf
else
  step "no exit node: the VM uses its own public IP"
  systemctl disable --now suplex-egress.service >/dev/null 2>&1 || true
  rm -f /etc/suplex-egress.nft /etc/systemd/system/suplex-egress.service /etc/systemd/system/suplex.service.d/egress.conf /etc/apt/apt.conf.d/99force-ipv4
  systemctl daemon-reload
  echo "egress ip: $(curl -4 -sS --max-time 20 https://ifconfig.me || echo NONE)"
fi

step "apt: public mirrors, gh"
# First boot runs apt (cloud-init, unattended upgrades); wait for its lock instead of failing.
echo 'DPkg::Lock::Timeout "600";' > /etc/apt/apt.conf.d/99lock-wait
# Hetzner's apt mirror answers only from inside Hetzner (not through an exit node); a no-op elsewhere.
sed -i "s|https\?://mirror.hetzner.com/ubuntu/packages|http://archive.ubuntu.com/ubuntu|g; s|https\?://mirror.hetzner.com/ubuntu/security|http://security.ubuntu.com/ubuntu|g" /etc/apt/sources.list.d/*.sources 2>/dev/null || true
command -v gh >/dev/null || { apt-get update -qq && apt-get install -y -qq gh >/dev/null; }
gh --version | head -1

step "docker (no docker group for suplex: that is root-equivalent; grant it only if tasks need Docker)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
# Containers cannot use the host's MagicDNS resolver (100.100.100.100); public resolvers go via the exit node.
# The bridge sits off 172.17/16: an exit node that advertises that subnet would swallow replies.
cat > /etc/docker/daemon.json <<'JSON'
{
  "dns": ["1.1.1.1", "8.8.8.8"],
  "bip": "10.200.0.1/24",
  "default-address-pools": [{"base": "10.201.0.0/16", "size": 24}]
}
JSON
systemctl enable docker >/dev/null 2>&1; systemctl restart docker
docker --version
echo "container egress ip: $(docker run --rm alpine wget -qO- -T 20 https://ifconfig.me/ip 2>/dev/null || echo NONE)"

step "suplex binary (root-owned, /usr/local/bin)"
[ -x /usr/local/bin/suplex ] || bash $T/install-suplex.sh
suplex version

step "tools as suplex: mise (node, pnpm, uv), herdr, agent tools (${AGENT_TOOLS:-none})"
as_suplex 'command -v mise >/dev/null || curl -fsSL https://mise.run | sh >/dev/null 2>&1; mise use -g node@24 pnpm@latest uv@latest >/dev/null 2>&1; mise install -q >/dev/null 2>&1; echo "node $(node --version) pnpm $(pnpm --version) uv $(uv --version | cut -d" " -f2)"'
for tool in $AGENT_TOOLS; do case $tool in
  claude-code) as_suplex 'command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1; claude --version' ;;
  codex) as_suplex 'command -v codex >/dev/null || { npm install -g @openai/codex >/dev/null 2>&1; mise reshim; }; codex --version' ;;
  devin) as_suplex 'command -v devin >/dev/null || curl -fsSL https://cli.devin.ai/install.sh | bash >/dev/null 2>&1; devin --version' ;;
  opencode) as_suplex '[ -x ~/.opencode/bin/opencode ] || curl -fsSL https://opencode.ai/install | bash >/dev/null 2>&1; ~/.opencode/bin/opencode --version' ;;
esac; done
as_suplex 'command -v herdr >/dev/null || curl -fsSL https://herdr.dev/install.sh | sh >/dev/null 2>&1; herdr --version | head -1'

step "github as suplex"
install -m 600 -o suplex -g suplex $T/github_key $H/.ssh/id_rsa
[ -f $T/github_key.pub ] && install -m 644 -o suplex -g suplex $T/github_key.pub $H/.ssh/id_rsa.pub
grep -q github.com $H/.ssh/known_hosts 2>/dev/null || { ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null >> $H/.ssh/known_hosts; chown suplex:suplex $H/.ssh/known_hosts; }
as_suplex "git config --global user.name '$GIT_NAME'; git config --global user.email '$GIT_EMAIL'"
# Suplex clones with the system git and this user's credentials; gh supplies them over HTTPS.
if as_suplex 'gh auth status >/dev/null 2>&1'; then as_suplex 'gh auth setup-git'; echo "git credential helper: gh"; fi
as_suplex 'ssh -T -o BatchMode=yes git@github.com 2>&1 | head -1' || true

if [ "$ACCESS" = cloudflare ]; then
  step "cloudflared: tunnel to https://$DOMAIN (outbound only)"
  if ! command -v cloudflared >/dev/null; then
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
  fi
  # The connector token is a positional argument of the service unit Cloudflare's installer writes.
  cloudflared service uninstall >/dev/null 2>&1 || true
  cloudflared service install "$CF_TUNNEL_TOKEN" >/dev/null 2>&1
  sleep 3; echo "cloudflared: $(systemctl is-active cloudflared) ($(cloudflared --version 2>/dev/null | head -1))"
elif [ -f /etc/systemd/system/cloudflared.service ]; then
  cloudflared service uninstall >/dev/null 2>&1 || true
fi

step "suplex installation (owned by suplex, access: $ACCESS)"
install -d -m 755 -o suplex -g suplex $DATA
umask 077
case "$ACCESS" in
  tailscale)
    FQDN=$(tailscale status --self --json | grep -m1 -o '"DNSName": *"[^"]*' | sed 's/.*"//; s/\.$//')
    printf 'SUPLEX_ACCESS_MODE=tailscale\nSUPLEX_TAILSCALE_EXPOSURE=serve\nSUPLEX_TAILSCALE_ADDRESS=%s\nSUPLEX_BIND_ADDRESS=127.0.0.1\n' "$FQDN" > $DATA/suplex.env ;;
  all)
    printf 'SUPLEX_ACCESS_MODE=all\nSUPLEX_BIND_ADDRESS=0.0.0.0\n' > $DATA/suplex.env ;;
  *)  # cloudflare and local: Suplex itself stays on loopback
    printf 'SUPLEX_ACCESS_MODE=local\nSUPLEX_BIND_ADDRESS=127.0.0.1\n' > $DATA/suplex.env ;;
esac
printf 'SUPLEX_PORT=%s\nSUPLEX_REPOSITORY_ROOT=%s/suplex/repos\nSUPLEX_WORKTREE_ROOT=%s/suplex/worktrees\n' "$PORT" "$H" "$H" >> $DATA/suplex.env
umask 022; chown suplex:suplex $DATA/suplex.env
rm -rf $H/.suplex   # a stray .suplex there would shadow the installation

if [ "$RESTORE" = y ]; then
  step "restore backup"
  # `suplex restore` verifies the archive, extracts it, and migrates the database to this build's schema.
  systemctl stop suplex 2>/dev/null || true
  install -m 600 -o suplex -g suplex $T/backup.tar.gz $H/suplex-backup.tar.gz
  STAGE=$(runuser -u suplex -- mktemp -d $H/restore.XXXXXX)
  as_suplex "suplex restore $H/suplex-backup.tar.gz $STAGE"
  install -d -m 755 -o suplex -g suplex $DATA/data $DATA/data/artifacts
  as_suplex "cp $STAGE/suplex-backup/app/suplex.sqlite $DATA/data/suplex.sqlite; rm -f $DATA/data/suplex.sqlite-wal $DATA/data/suplex.sqlite-shm"
  [ -d $STAGE/suplex-backup/app/artifacts ] && as_suplex "cp -a $STAGE/suplex-backup/app/artifacts/. $DATA/data/artifacts/"
  grep -A6 nextSteps $STAGE/suplex-backup/restore-handoff.json 2>/dev/null || true
  rm -rf "$STAGE" $H/suplex-backup.tar.gz
  echo "restored; projects keep their stored repository paths, so re-add any whose path does not exist here"
fi

step "herdr + suplex services (User=suplex, start on boot, port $PORT)"
install -m 644 $T/herdr.service /etc/systemd/system/herdr.service
install -m 644 $T/suplex.service /etc/systemd/system/suplex.service
install -d /etc/systemd/system/suplex.service.d
# Suplex binds the same port Serve exposes; below 1024 that needs the bind capability (fine with NoNewPrivileges).
if [ "$PORT" -lt 1024 ]; then printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n' > /etc/systemd/system/suplex.service.d/port.conf
else rm -f /etc/systemd/system/suplex.service.d/port.conf; fi
# Serve routes from an earlier port or mode would linger; the supervisor re-adds the current one on start.
command -v tailscale >/dev/null && tailscale serve reset >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl enable herdr.service suplex.service >/dev/null 2>&1
systemctl restart herdr.service; systemctl restart suplex.service
sleep 6
rm -rf $T
if [ "$ACCESS" = tailscale ] && [ "$EXPOSURE" = funnel ]; then
  # Suplex's supervisor re-applies `tailscale serve` on every start, which drops the Funnel flag, so a
  # timer puts it back. `tailscale funnel --bg` is idempotent.
  cat > /etc/systemd/system/suplex-funnel.service <<UNIT
[Unit]
Description=Keep Tailscale Funnel on for Suplex (public URL)
After=suplex.service tailscaled.service
[Service]
Type=oneshot
ExecStart=/usr/bin/tailscale funnel --bg --https=$PORT http://127.0.0.1:$PORT
UNIT
  cat > /etc/systemd/system/suplex-funnel.timer <<UNIT
[Unit]
Description=Re-apply Tailscale Funnel for Suplex
[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload; systemctl enable --now suplex-funnel.timer >/dev/null 2>&1
  systemctl start suplex-funnel.service || echo "funnel: enable it for this tailnet first (the command above prints the admin-console link), then rerun"
  tailscale funnel status 2>/dev/null | grep -A1 "Funnel on" | tail -1 | sed 's/^# *- */funnel: /'
elif [ -f /etc/systemd/system/suplex-funnel.timer ]; then
  systemctl disable --now suplex-funnel.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/suplex-funnel.timer /etc/systemd/system/suplex-funnel.service; systemctl daemon-reload
  command -v tailscale >/dev/null && tailscale funnel --https=$PORT off >/dev/null 2>&1 || true
fi
echo "user: $(systemctl show suplex -p User --value)  enabled: $(systemctl is-enabled suplex)  active: $(systemctl is-active suplex)  herdr: $(systemctl is-active herdr)"
curl -sS -o /dev/null -w "health %{http_code}\n" --max-time 10 http://127.0.0.1:$PORT/health
# The external HTTPS origin Suplex trusts behind a proxy. Loopback requests act as the Operator, so plain curl works.
if [ "$ACCESS" = cloudflare ]; then ORIGIN="\"https://$DOMAIN\""; else ORIGIN=null; fi
curl -sS -o /dev/null -w "external origin $ORIGIN: http %{http_code}\n" --max-time 10 -X PUT -H 'Content-Type: application/json' \
  -d "{\"externalHttpsOrigin\":$ORIGIN}" http://127.0.0.1:$PORT/api/admin/access || true

step "doctor"
as_suplex 'suplex doctor --summary' || true
