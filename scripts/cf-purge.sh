#!/usr/bin/env bash
# Сброс кеша Cloudflare для зоны после выкладки сайта.
# Нужны: CLOUDFLARE_API_TOKEN и ZONE (домен или zone id).
set -euo pipefail

zone="${1:-${CLOUDFLARE_ZONE:-}}"
if [[ -z "$zone" ]]; then
  echo "Usage: $0 <zone-or-domain>"
  exit 1
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Нет CLOUDFLARE_API_TOKEN"
  exit 1
fi

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

# Resolve domain → zone id when needed.
if [[ "$zone" == *.* ]]; then
  zone_id="$(
    curl -sS "${auth[@]}" "${api}/zones?name=${zone}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);const z=j.result?.[0]; if(!z){process.stderr.write("Zone not found\n"); process.exit(1)} process.stdout.write(z.id)})'
  )"
else
  zone_id="$zone"
fi

curl -sS -X POST "${auth[@]}" \
  "${api}/zones/${zone_id}/purge_cache" \
  --data '{"purge_everything":true}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s); if(!j.success){console.error(JSON.stringify(j.errors||j,null,2)); process.exit(1)} console.log("Cloudflare cache purged:", process.argv[1])})' "$zone"
