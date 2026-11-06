/**
 * Cloudflare Pages Function: приём заявок с формы и отправка в Telegram.
 * Работает только на Cloudflare Pages (или другом хостинге с поддержкой functions).
 *
 * Нужны переменные окружения (Settings → Environment variables):
 *   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID   — ваш chat_id (подскажет @userinfobot)
 *
 * Если переменных нет — возвращаем 503, а форма на сайте предложит
 * написать в Telegram напрямую (текст она соберёт сама).
 */

type Env = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

type Payload = {
  name?: unknown;
  task?: unknown;
  company?: unknown;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function onRequestPost({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return json({ ok: false, error: "not_configured" }, 503);
  }

  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }

  // honeypot: боты заполняют скрытое поле
  if (typeof body.company === "string" && body.company.trim() !== "") {
    return json({ ok: true });
  }

  const name = String(body.name ?? "").trim().slice(0, 100);
  const task = String(body.task ?? "").trim().slice(0, 2000);

  if (name.length < 2 || task.length < 10) {
    return json({ ok: false, error: "validation" }, 422);
  }

  const text = [`Новая заявка с сайта`, ``, `Имя: ${name}`, ``, task].join("\n");

  const telegram = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!telegram.ok) {
    return json({ ok: false, error: "telegram_failed" }, 502);
  }

  return json({ ok: true });
}

export async function onRequestGet(): Promise<Response> {
  return json({ ok: false, error: "method_not_allowed" }, 405);
}
