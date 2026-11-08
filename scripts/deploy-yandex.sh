#!/usr/bin/env bash
# Сайт в Object Storage, заявка — Cloud Function, оба адреса на одном API Gateway.
# Нужны: yc init, привязанный платёжный аккаунт и .env с токеном бота.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v yc >/dev/null 2>&1; then
  echo "Не найден yc. Поставьте CLI и войдите в облако:"
  echo "  https://yandex.cloud/ru/docs/cli/quickstart"
  echo "  yc init"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Нужен node, чтобы собрать сайт."
  exit 1
fi

folder_id="$(yc config get folder-id 2>/dev/null || true)"
if [[ -z "$folder_id" ]]; then
  echo "Каталог не выбран. Выполните: yc init"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Нет .env. Скопируйте .env.example и впишите TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID."
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

token="$(read_env TELEGRAM_BOT_TOKEN)"
chat_id="$(read_env TELEGRAM_CHAT_ID)"
if [[ -z "$token" || -z "$chat_id" ]]; then
  echo "В .env пустые TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID."
  exit 1
fi

admin_password="$(read_env ADMIN_PASSWORD)"
if [[ -z "$admin_password" ]]; then
  admin_password="$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)"
  printf '\nADMIN_PASSWORD=%s\n' "$admin_password" >> .env
  echo "В .env записан ADMIN_PASSWORD"
fi

json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const value = process.argv[1].split(".").reduce((obj, key) => obj?.[key], JSON.parse(s));
      if (value == null || value === "") process.exit(1);
      process.stdout.write(String(value));
    });
  ' "$1"
}

exists() {
  "$@" >/dev/null 2>&1
}

sa_name="sajty-gateway"
fn_name="sajty-lead"
gw_name="sajty"
bucket="sajty-${folder_id}"
leads_bucket="sajty-leads-${folder_id}"

if exists yc iam service-account get --name "$sa_name"; then
  sa_id="$(yc iam service-account get --name "$sa_name" --format json | json_field id)"
else
  echo "Сервисный аккаунт $sa_name"
  sa_id="$(yc iam service-account create --name "$sa_name" --format json | json_field id)"
fi

if exists yc storage bucket get "$bucket"; then
  echo "Бакет $bucket уже есть"
else
  echo "Бакет $bucket"
  yc storage bucket create --name "$bucket" >/dev/null
fi

if exists yc storage bucket get "$leads_bucket"; then
  echo "Бакет заявок уже есть"
else
  echo "Бакет заявок $leads_bucket"
  yc storage bucket create --name "$leads_bucket" >/dev/null
fi

if exists yc serverless function get --name "$fn_name"; then
  function_id="$(yc serverless function get --name "$fn_name" --format json | json_field id)"
else
  echo "Функция $fn_name"
  function_id="$(yc serverless function create --name "$fn_name" --format json | json_field id)"
fi

has_folder_role() {
  yc resource-manager folder list-access-bindings --id "$folder_id" --format json | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      const role = process.argv[1];
      const id = process.argv[2];
      const list = JSON.parse(s);
      const ok = list.some((binding) => (binding.role_id || binding.role) === role && binding.subject && binding.subject.id === id);
      process.exit(ok ? 0 : 1);
    });
  ' "$1" "$sa_id"
}

echo "Права сервисного аккаунта"
if ! has_folder_role storage.editor; then
  yc resource-manager folder add-access-binding --id "$folder_id" --role storage.editor --service-account-id "$sa_id" >/dev/null
fi
if ! yc serverless function list-access-bindings --name "$fn_name" --format json | grep -q "$sa_id"; then
  yc serverless function add-access-binding --name "$fn_name" --role functions.functionInvoker --service-account-id "$sa_id" >/dev/null
fi

key_file="$root/yandex/.lead-key"
if [[ ! -f "$key_file" ]]; then
  echo "Ключ доступа к заявкам"
  yc iam access-key create --service-account-id "$sa_id" --format json >"$key_file"
  chmod 600 "$key_file"
fi
lead_access_key="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.access_key.key_id)' "$key_file")"
lead_secret_key="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(j.secret)' "$key_file")"

echo "Версия функции"
yc serverless function version create \
  --function-name "$fn_name" \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 128m \
  --execution-timeout 10s \
  --source-path "$root/yandex/lead" \
  --service-account-id "$sa_id" \
  --environment "TELEGRAM_BOT_TOKEN=${token}" \
  --environment "TELEGRAM_CHAT_ID=${chat_id}" \
  --environment "LEADS_BUCKET=${leads_bucket}" \
  --environment "LEAD_ACCESS_KEY_ID=${lead_access_key}" \
  --environment "LEAD_SECRET_ACCESS_KEY=${lead_secret_key}" \
  --environment "ADMIN_PASSWORD=${admin_password}" \
  >/dev/null

if ! yc storage s3api head-object --bucket "$leads_bucket" --key content/site.json >/dev/null 2>&1; then
  echo "Начальный контент"
  yc storage s3 cp "$root/yandex/lead/content.default.json" "s3://${leads_bucket}/content/site.json" --content-type "application/json" --quiet
fi

spec="$root/yandex/.apigw.yaml"
sed \
  -e "s/__BUCKET__/${bucket}/g" \
  -e "s/__FUNCTION_ID__/${function_id}/g" \
  -e "s/__SA_ID__/${sa_id}/g" \
  "$root/yandex/apigw.template.yaml" >"$spec"

if exists yc serverless api-gateway get --name "$gw_name"; then
  echo "Обновляю API Gateway"
  yc serverless api-gateway update --name "$gw_name" --spec "$spec" >/dev/null
else
  echo "Создаю API Gateway"
  yc serverless api-gateway create --name "$gw_name" --spec "$spec" >/dev/null
fi

domain="$(yc serverless api-gateway get --name "$gw_name" --format json | json_field domain)"
site_url="https://${domain}"

if [[ "${SKIP_SITE:-}" == "1" ]]; then
  echo
  echo "Сайт: ${site_url}"
  echo "Админка: ${site_url}/admin"
  echo "Форма: ${site_url}/api/lead"
  exit 0
fi

echo "Сборка сайта для ${site_url}"
SITE_URL="$site_url" BASE_PATH=/ npm run build

content_type() {
  case "$1" in
    *.html) echo "text/html; charset=utf-8" ;;
    *.css) echo "text/css; charset=utf-8" ;;
    *.js|*.mjs) echo "text/javascript; charset=utf-8" ;;
    *.svg) echo "image/svg+xml" ;;
    *.png) echo "image/png" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.webp) echo "image/webp" ;;
    *.woff2) echo "font/woff2" ;;
    *.xml) echo "application/xml" ;;
    *.txt|*.nojekyll) echo "text/plain; charset=utf-8" ;;
    *) echo "application/octet-stream" ;;
  esac
}

echo "Заливаю dist/ в бакет"
while IFS= read -r -d '' file; do
  rel="${file#"$root/dist"/}"
  yc storage s3 cp "$file" "s3://${bucket}/${rel}" --content-type "$(content_type "$rel")" --quiet
done < <(find "$root/dist" -type f -print0)

mkdir -p "$root/yandex"
cat >"$root/yandex/.state" <<EOF
BUCKET=${bucket}
FUNCTION_ID=${function_id}
SA_ID=${sa_id}
DOMAIN=${domain}
EOF

echo
echo "Сайт: ${site_url}"
echo "Админка: ${site_url}/admin"
echo "Форма: ${site_url}/api/lead"
