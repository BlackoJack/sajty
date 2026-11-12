#!/usr/bin/env bash
# Кладёт локальные ключи в секреты GitHub. Значения не печатает.
# Перед запуском: gh auth login -h github.com
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI не вошёл в аккаунт. Выполните: gh auth login -h github.com"
  exit 1
fi

read_env() {
  local line val
  line="$(grep -E "^${1}=" .env | tail -n 1 || true)"
  val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  printf "%s" "$val"
}

for file in yandex/.ci-key.json yandex/.lead-key .env; do
  if [[ ! -f "$file" ]]; then
    echo "Нет файла $file"
    exit 1
  fi
done

folder_id="$(yc config get folder-id)"
token="$(read_env TELEGRAM_BOT_TOKEN)"
chat_id="$(read_env TELEGRAM_CHAT_ID)"
admin_password="$(read_env ADMIN_PASSWORD)"

if [[ -z "$folder_id" || -z "$token" || -z "$chat_id" || -z "$admin_password" ]]; then
  echo "Пустой каталог yc или одно из полей .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ADMIN_PASSWORD."
  exit 1
fi

gh secret set YC_SA_JSON < yandex/.ci-key.json
gh secret set YC_LEAD_KEY < yandex/.lead-key
gh secret set YC_FOLDER_ID --body "$folder_id"
gh secret set TELEGRAM_BOT_TOKEN --body "$token"
gh secret set TELEGRAM_CHAT_ID --body "$chat_id"
gh secret set ADMIN_PASSWORD --body "$admin_password"

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  gh secret set CLOUDFLARE_API_TOKEN --body "$CLOUDFLARE_API_TOKEN"
  gh secret set CLOUDFLARE_ACCOUNT_ID --body "${CLOUDFLARE_ACCOUNT_ID:-73d901a62883a2338be9fc9f14b61035}"
  echo "Секреты Cloudflare записаны"
else
  echo "CLOUDFLARE_API_TOKEN не задан в окружении — CF-секреты пропущены"
fi

echo "Секреты записаны: YC_SA_JSON, YC_LEAD_KEY, YC_FOLDER_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ADMIN_PASSWORD"
