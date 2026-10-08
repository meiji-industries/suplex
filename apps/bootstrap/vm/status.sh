systemctl is-active tailscaled suplex-egress cloudflared herdr suplex | paste -sd" " | sed "s/^/services (tailscaled egress cloudflared herdr suplex): /"
echo "service user: $(systemctl show suplex -p User --value)"
grep -m1 SUPLEX_ACCESS_MODE /home/suplex/.local/share/Suplex/suplex.env 2>/dev/null | sed "s/^/access: /"
if command -v tailscale >/dev/null; then
  tailscale serve status 2>/dev/null | head -1 | sed "s/^/serve: /"
  tailscale funnel status 2>/dev/null | grep -q "Funnel on" && echo "funnel: ON (public)" || echo "funnel: off"
  if tailscale status --json | grep -A3 ExitNodeStatus | grep -q '"Online": true'; then echo "exit node: online"; else echo "exit node: none or offline"; fi
fi
echo "egress ip: $(curl -4 -sS --max-time 15 https://ifconfig.me || echo NONE)"
wan=$(ip -o -4 route show default | awk '{print $5; exit}')
echo "direct $wan: $(curl -4 -sS --max-time 5 --interface "$wan" https://ifconfig.me 2>/dev/null || echo blocked)"
curl -sS -o /dev/null -w "health %{http_code}\n" --max-time 10 http://127.0.0.1:${SUPLEX_PORT:-4111}/health || echo "health: no answer"
echo "claude as suplex: $(runuser -u suplex -- env HOME=/home/suplex PATH=/home/suplex/.local/bin:/usr/bin:/bin claude --version 2>&1 | head -1)"
