#!/bin/sh
# Points suplex.sh and www.suplex.sh at the Fly app suplex-production with DNS-only A and AAAA records.
# Run through `mise run hosted:dns`, which reads CF_DNS_ACCOUNT_ID and CF_DNS_API_TOKEN from 1Password.
set -eu
api=https://api.cloudflare.com/client/v4
cf() { curl -fsS -H "Authorization: Bearer $CF_DNS_API_TOKEN" -H "Content-Type: application/json" "$@"; }

zone="$(cf "$api/zones?name=suplex.sh&account.id=$CF_DNS_ACCOUNT_ID" | jq -r '.result[0].id // empty')"
[ -n "$zone" ] || { echo "Cloudflare cannot find the zone suplex.sh in this account" >&2; exit 1; }
ips="$(fly ips list --app suplex-production --json)"
for name in suplex.sh www.suplex.sh; do
  for type in A AAAA; do
    [ "$type" = A ] && kinds='["v4","shared_v4"]' || kinds='["v6"]'
    address="$(printf '%s' "$ips" | jq -r --argjson kinds "$kinds" '[.[] | select(.Type as $t | $kinds | index($t))][0].Address // empty')"
    [ -n "$address" ] || { echo "Fly has no $type address for suplex-production" >&2; exit 1; }
    record="$(jq -n --arg type "$type" --arg name "$name" --arg content "$address" '{type: $type, name: $name, content: $content, ttl: 1, proxied: false}')"
    existing="$(cf "$api/zones/$zone/dns_records?type=$type&name=$name" | jq -r '.result[0].id // empty')"
    if [ -n "$existing" ]; then
      cf -X PUT "$api/zones/$zone/dns_records/$existing" --data "$record" >/dev/null
    else
      cf -X POST "$api/zones/$zone/dns_records" --data "$record" >/dev/null
    fi
    echo "$type $name -> $address"
  done
  fly certs show "$name" --app suplex-production >/dev/null 2>&1 || fly certs add "$name" --app suplex-production
  fly certs check "$name" --app suplex-production
done
