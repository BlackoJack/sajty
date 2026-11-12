#!/usr/bin/env bash
# Пинг sitemap после выкладки: Яндекс + IndexNow.
set -euo pipefail

site_url="${1:-${PUBLIC_SITE_URL:-https://sitly.ru}}"
site_url="${site_url%/}"
sitemap="${site_url}/sitemap-index.xml"
host="${site_url#https://}"
host="${host#http://}"
host="${host%%/*}"

echo "Yandex Webmaster ping: ${sitemap}"
enc="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$sitemap")"
curl -sS -o /dev/null -w "yandex_http=%{http_code}\n" --max-time 20 \
  "https://webmaster.yandex.ru/ping?sitemap=${enc}" || true

key="${PUBLIC_INDEXNOW_KEY:-}"
if [[ -z "$key" && -f public/sitly-indexnow.txt ]]; then
  key="$(tr -d '[:space:]' < public/sitly-indexnow.txt)"
fi

if [[ -n "$key" ]]; then
  echo "IndexNow: ${site_url}/"
  payload="$(PUBLIC_INDEXNOW_KEY="$key" SITE_URL="$site_url" HOST="$host" python3 - <<'PY'
import json, os
key = os.environ["PUBLIC_INDEXNOW_KEY"]
site = os.environ["SITE_URL"].rstrip("/")
print(json.dumps({
  "host": os.environ["HOST"],
  "key": key,
  "keyLocation": f"{site}/sitly-indexnow.txt",
  "urlList": [f"{site}/", f"{site}/sitemap-index.xml"],
}))
PY
)"
  curl -sS -o /dev/null -w "indexnow_http=%{http_code}\n" --max-time 20 \
    -X POST "https://api.indexnow.org/indexnow" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$payload" || true
else
  echo "IndexNow key отсутствует — пропуск (включите Cloudflare Crawler Hints)"
fi
