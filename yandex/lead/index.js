/**
 * Yandex Cloud Functions: заявка, публичный контент и админка.
 *
 * Публичный JSON: цены, три позиции, контакты на сайте.
 * Закрытый JSON private/notify.json: токен бота, chat id, SMTP. В /api/content его нет.
 * TELEGRAM_* в окружении — запас, пока админка ничего не сохранила.
 * LEADS_BUCKET, LEAD_ACCESS_KEY_ID, LEAD_SECRET_ACCESS_KEY — бакет заявок и контента.
 * ADMIN_PASSWORD — пароль страницы /admin. В ответ и в логи не попадает.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const tls = require("tls");

const DEFAULT_CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8"));
const PACKAGE_IDS = ["visitka", "landing", "catalog"];
const PRICE_KEYS = ["visitka", "landing", "catalog", "texts", "setup", "support"];
const CONTENT_KEY = "content/site.json";
const NOTIFY_KEY = "private/notify.json";

const json = (statusCode, body) => ({
  statusCode,
  isBase64Encoded: false,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  },
  body: JSON.stringify(body),
});

const empty = (statusCode) => ({
  statusCode,
  isBase64Encoded: false,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  },
  body: "",
});

function readPayload(event) {
  if (!event || typeof event !== "object") return { error: "bad_json" };
  let raw = event.body;
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  if (event.isBase64Encoded === true) raw = Buffer.from(String(raw), "base64").toString("utf8");
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object") return { error: "bad_json" };
    return parsed;
  } catch {
    return { error: "bad_json" };
  }
}

function header(event, name) {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? String(headers[key]) : "";
}

function routeOf(event) {
  const route = event?.requestContext?.apiGateway?.operationContext?.route;
  if (route) return String(route);
  const pathName = String(event?.path || event?.url || event?.requestContext?.path || "");
  if (pathName.includes("/api/content")) return "content";
  if (pathName.includes("/api/admin")) return "admin";
  return "lead";
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function passwordOk(given) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || !given) return false;
  const left = Buffer.from(sha256(expected));
  const right = Buffer.from(sha256(String(given)));
  return crypto.timingSafeEqual(left, right);
}

function cleanText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return "";
  return text;
}

function addressOf(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(text) || text.length > 120) return "";
  return text;
}

function hostnameOf(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(text)) return "";
  return text;
}

function cleanContactUrl(value, protocol, hosts) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 400 || /[\s<>]/.test(text)) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== protocol || url.username || url.password) return "";
  if (hosts && !hosts.includes(url.hostname.toLowerCase())) return "";
  if (protocol === "mailto:") {
    const address = addressOf(url.pathname);
    return address ? `mailto:${address}` : "";
  }
  return url.toString();
}

function contactFromTelegram(value) {
  const raw = String(value ?? "").trim();
  let user = "";
  if (raw.startsWith("@")) user = raw.slice(1);
  else if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname.toLowerCase() === "t.me" || url.hostname.toLowerCase() === "telegram.me") {
        user = url.pathname.replace(/^\//, "").split("/")[0];
      }
    } catch {
      user = "";
    }
  } else user = raw;
  if (!/^[A-Za-z0-9_]{4,32}$/.test(user)) return null;
  return { label: `@${user}`, url: `https://t.me/${user}` };
}

function contactFromPhone(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  const normalized = digits.length === 11 && digits.startsWith("8") ? `7${digits.slice(1)}` : digits;
  const label = raw.length <= 40 ? raw : `+${normalized}`;
  return { label, url: `https://wa.me/${normalized}` };
}

function contactFromEmail(value) {
  const address = addressOf(value);
  if (!address) return null;
  return { label: address, url: `mailto:${address}` };
}

function contactFromMax(value) {
  if (!value || typeof value !== "object") return null;
  const label = cleanText(value.label, 40);
  const url = cleanContactUrl(value.url, "https:", ["max.ru"]);
  if (!label || !url) return null;
  return { label, url };
}

function sanitizeContacts(input) {
  if (!input || typeof input !== "object") return null;
  const telegram = contactFromTelegram(typeof input.telegram === "string" ? input.telegram : input.telegram?.label || input.telegram?.url);
  const whatsapp = contactFromPhone(typeof input.whatsapp === "string" ? input.whatsapp : input.whatsapp?.label || input.whatsapp?.url);
  const email = contactFromEmail(typeof input.email === "string" ? input.email : input.email?.label || input.email?.url);
  const max = contactFromMax(input.max);
  if (!telegram || !whatsapp || !email || !max) return null;
  return { telegram, whatsapp, max, email };
}

function sanitizeContent(input) {
  if (!input || typeof input !== "object") return null;
  const price = {};
  for (const key of PRICE_KEYS) {
    const number = Number(input.price?.[key]);
    if (!Number.isInteger(number) || number < 0 || number > 10000000) return null;
    price[key] = number;
  }
  if (!Array.isArray(input.packages)) return null;
  const packages = [];
  for (const id of PACKAGE_IDS) {
    const item = input.packages.find((pkg) => pkg && pkg.id === id);
    if (!item) return null;
    const name = cleanText(item.name, 40);
    const tagline = cleanText(item.tagline, 300);
    const bestFor = cleanText(item.bestFor, 300);
    if (!name || !tagline || !bestFor) return null;
    if (!Array.isArray(item.items) || item.items.length < 1 || item.items.length > 8) return null;
    const items = item.items.map((line) => cleanText(line, 80));
    if (items.some((line) => !line)) return null;
    packages.push({ id, name, tagline, bestFor, items });
  }
  const contacts = input.contacts == null ? sanitizeContacts(DEFAULT_CONTENT.contacts) : sanitizeContacts(input.contacts);
  if (!contacts) return null;
  return { price, packages, contacts };
}

function sanitizeNotify(input, previous) {
  const prev = previous && typeof previous === "object" ? previous : {};
  if (!input || typeof input !== "object") return null;
  const tokenRaw = String(input.telegramToken ?? "").trim();
  const chatRaw = String(input.telegramChatId ?? "").trim();
  const telegramToken = tokenRaw || String(prev.telegramToken ?? "").trim();
  const telegramChatId = chatRaw || String(prev.telegramChatId ?? "").trim();
  if (telegramToken && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) return null;
  if (telegramChatId && !/^-?\d{1,20}$/.test(telegramChatId)) return null;
  if (input.mailTo && !addressOf(input.mailTo)) return null;
  if (input.smtpUser && !addressOf(input.smtpUser)) return null;
  if (input.smtpHost && !hostnameOf(input.smtpHost)) return null;
  const requestedPort = input.smtpPort == null || input.smtpPort === "" ? 465 : Number(input.smtpPort);
  if (requestedPort !== 465) return null;
  const smtpPassword = String(input.smtpPassword ?? "") || String(prev.smtpPassword ?? "");
  if (smtpPassword.length > 200 || /[\r\n]/.test(smtpPassword)) return null;
  const mailTo = addressOf(input.mailTo) || addressOf(prev.mailTo);
  const smtpUser = addressOf(input.smtpUser) || addressOf(prev.smtpUser);
  const smtpHost = hostnameOf(input.smtpHost) || hostnameOf(prev.smtpHost) || "smtp.gmail.com";
  if (smtpPassword && (!smtpUser || !mailTo)) return null;
  return { telegramToken, telegramChatId, mailTo, smtpHost, smtpPort: 465, smtpUser, smtpPassword };
}

async function s3(method, objectKey, { query = null, body = "", contentType = "" } = {}) {
  const bucket = process.env.LEADS_BUCKET;
  const accessKey = process.env.LEAD_ACCESS_KEY_ID;
  const secretKey = process.env.LEAD_SECRET_ACCESS_KEY;
  if (!bucket || !accessKey || !secretKey) return { ok: false, status: 0, text: "" };

  const host = "storage.yandexcloud.net";
  const region = "ru-central1";
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const encodedKey = objectKey ? objectKey.split("/").map(encodeRfc3986).join("/") : "";
  const canonicalUri = `/${bucket}${encodedKey ? `/${encodedKey}` : ""}`;
  const canonicalQuery = query
    ? Object.keys(query)
        .sort()
        .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(String(query[key]))}`)
        .join("&")
    : "";
  const headerLines = [["host", host], ["x-amz-content-sha256", payloadHash], ["x-amz-date", amzDate]];
  if (contentType) headerLines.push(["content-type", contentType]);
  headerLines.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalHeaders = headerLines.map(([key, value]) => `${key}:${value}\n`).join("");
  const signedHeaders = headerLines.map(([key]) => key).join(";");
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = { Authorization: authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (contentType) headers["Content-Type"] = contentType;

  const response = await fetch(`https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
    method,
    headers,
    body: method === "GET" || method === "DELETE" || method === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function readContent() {
  const stored = await s3("GET", CONTENT_KEY);
  if (stored.status === 404 || stored.status === 0) return DEFAULT_CONTENT;
  if (!stored.ok) return null;
  try {
    const parsed = sanitizeContent(JSON.parse(stored.text));
    return parsed || DEFAULT_CONTENT;
  } catch {
    return DEFAULT_CONTENT;
  }
}

async function writeContent(content) {
  const result = await s3("PUT", CONTENT_KEY, {
    body: JSON.stringify(content),
    contentType: "application/json",
  });
  return result.ok;
}

async function readNotify() {
  const stored = await s3("GET", NOTIFY_KEY);
  let saved = {};
  if (stored.ok) {
    try {
      const parsed = JSON.parse(stored.text);
      if (parsed && typeof parsed === "object") saved = parsed;
    } catch {
      saved = {};
    }
  }
  const fallbackMail = addressOf(DEFAULT_CONTENT.contacts?.email?.label);
  const draft = {
    telegramToken: saved.telegramToken || process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: saved.telegramChatId || process.env.TELEGRAM_CHAT_ID || "",
    mailTo: saved.mailTo || fallbackMail,
    smtpHost: saved.smtpHost || "smtp.gmail.com",
    smtpPort: 465,
    smtpUser: saved.smtpUser || fallbackMail,
    smtpPassword: saved.smtpPassword || "",
  };
  return (
    sanitizeNotify(draft, {}) ||
    sanitizeNotify({ ...draft, telegramToken: "", telegramChatId: "" }, {}) || {
      telegramToken: "",
      telegramChatId: "",
      mailTo: fallbackMail,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpUser: fallbackMail,
      smtpPassword: "",
    }
  );
}

async function writeNotify(notify) {
  const result = await s3("PUT", NOTIFY_KEY, {
    body: JSON.stringify(notify),
    contentType: "application/json",
  });
  return result.ok;
}

function createSession(socket) {
  let buffer = "";
  const queue = [];
  let pending = null;
  const push = (line) => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else queue.push(line);
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.length >= 4 && line[3] === " ") push(line);
    }
  });
  return {
    socket,
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    write(line) {
      socket.write(`${line}\r\n`);
    },
  };
}

function openSmtp(host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({ host, port, servername: host });
    const session = createSession(socket);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("smtp_timeout"));
    }, 8000);
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(session);
    });
  });
}

function expectCode(session, codes) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("smtp_timeout")), 8000);
    session.read().then(
      (line) => {
        clearTimeout(timer);
        const code = Number(String(line).slice(0, 3));
        if (!codes.includes(code)) reject(new Error(`smtp_${code}`));
        else resolve(code);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function encodeSubject(subject) {
  const clean = String(subject).replace(/[\r\n]+/g, " ").trim().slice(0, 180);
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

async function smtpReachable(host, port) {
  let session;
  try {
    session = await openSmtp(host, port);
    await expectCode(session, [220]);
    session.write("QUIT");
    return true;
  } catch {
    return false;
  } finally {
    session?.socket.destroy();
  }
}

async function sendSmtp({ host, port, user, password, to, subject, text }) {
  const from = addressOf(user);
  const recipient = addressOf(to);
  if (!from || !recipient || !hostnameOf(host) || !password) throw new Error("smtp_config");
  const stuffed = String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  const payload = [
    `From: ${from}`,
    `To: ${recipient}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    stuffed,
    ".",
  ].join("\r\n");
  const session = await openSmtp(host, port || 465);
  try {
    await expectCode(session, [220]);
    session.write("EHLO sajty");
    await expectCode(session, [250]);
    session.write("AUTH LOGIN");
    await expectCode(session, [334]);
    session.write(Buffer.from(from).toString("base64"));
    await expectCode(session, [334]);
    session.write(Buffer.from(String(password)).toString("base64"));
    await expectCode(session, [235]);
    session.write(`MAIL FROM:<${from}>`);
    await expectCode(session, [250]);
    session.write(`RCPT TO:<${recipient}>`);
    await expectCode(session, [250, 251]);
    session.write("DATA");
    await expectCode(session, [354]);
    session.socket.write(`${payload}\r\n`);
    await expectCode(session, [250]);
    session.write("QUIT");
    await expectCode(session, [221]);
  } finally {
    session.socket.destroy();
  }
}

function smtpErrorCode(error) {
  const message = String(error?.message || "");
  if (/^smtp_\d{3}$/.test(message) || message === "smtp_timeout" || message === "smtp_config") return message;
  return "smtp_failed";
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function listKeys(xml) {
  const keys = [];
  const pattern = /<Key>([^<]+)<\/Key>/g;
  let match = pattern.exec(xml);
  while (match) {
    const key = match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (key.startsWith("leads/") && key.endsWith(".json") && !key.includes("..")) keys.push(key);
    match = pattern.exec(xml);
  }
  return keys;
}

function leadKeyOk(key) {
  return typeof key === "string" && /^leads\/[0-9TZ.\-]+\.json$/.test(key);
}

async function listLeads() {
  const listed = await s3("GET", "", { query: { "list-type": "2", prefix: "leads/" } });
  if (!listed.ok) return null;
  const keys = listKeys(listed.text).sort().reverse().slice(0, 30);
  const rows = await Promise.all(
    keys.map(async (key) => {
      const object = await s3("GET", key);
      if (!object.ok) return null;
      try {
        const data = JSON.parse(object.text);
        return {
          key,
          name: String(data.name ?? "").trim().slice(0, 100),
          contact: String(data.contact ?? "").trim().slice(0, 120),
          task: String(data.task ?? "").replace(/\r\n/g, "\n").trim().slice(0, 2000),
          at: String(data.at ?? "").trim().slice(0, 40),
          notified: typeof data.mailConfigured === "boolean",
          mail: data.mail === true,
          telegram: data.telegram === true,
          mailConfigured: data.mailConfigured === true,
          telegramConfigured: data.telegramConfigured === true,
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function putLead(objectKey, record) {
  const result = await s3("PUT", objectKey, {
    body: JSON.stringify(record),
    contentType: "application/json",
  });
  return result.ok;
}

function leadMessage(name, contact, task) {
  return ["Новая заявка с сайта", "", `Имя: ${name}`, `Связь: ${contact}`, "", task].join("\n");
}

async function deliverLead(name, contact, task) {
  const notify = await readNotify();
  const text = leadMessage(name, contact, task);
  const mailConfigured = Boolean(notify?.smtpPassword && notify.smtpUser && notify.mailTo);
  const telegramConfigured = Boolean(notify?.telegramToken && notify.telegramChatId);
  const mail = mailConfigured
    ? withTimeout(
        sendSmtp({
          host: notify.smtpHost,
          port: 465,
          user: notify.smtpUser,
          password: notify.smtpPassword,
          to: notify.mailTo,
          subject: `Заявка с сайта: ${name}`,
          text,
        }).then(() => true),
        9000,
      )
    : Promise.resolve(false);
  const telegram = telegramConfigured
    ? withTimeout(sendTelegram(notify.telegramToken, notify.telegramChatId, text), 4000)
    : Promise.resolve(false);
  const [mailOk, telegramOk] = await Promise.all([mail, telegram]);
  return {
    mail: mailOk === true,
    telegram: telegramOk === true,
    mailConfigured,
    telegramConfigured,
  };
}

async function sendTelegram(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(4000),
  });
  return response.ok;
}

async function handleContent(method) {
  if (method === "OPTIONS") return empty(204);
  if (method !== "GET") return json(405, { ok: false, error: "method_not_allowed" });
  const content = await readContent();
  if (!content) return json(502, { ok: false, error: "content_unavailable" });
  return json(200, content);
}

async function handleAdmin(event, method) {
  if (method === "OPTIONS") return empty(204);
  if (method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!process.env.ADMIN_PASSWORD) return json(503, { ok: false, error: "not_configured" });
  if (!passwordOk(header(event, "x-admin-password"))) return json(401, { ok: false, error: "unauthorized" });

  const body = readPayload(event);
  if (body.error === "bad_json") return json(400, { ok: false, error: "bad_json" });
  const action = String(body.action || "");

  if (action === "login") return json(200, { ok: true });

  if (action === "settings") {
    const notify = await readNotify();
    if (!notify) return json(502, { ok: false, error: "notify_unavailable" });
    return json(200, { ok: true, notify });
  }

  if (action === "save") {
    const content = sanitizeContent(body.content);
    const notify = sanitizeNotify(body.notify, await readNotify());
    if (!content || !notify) return json(422, { ok: false, error: "validation" });
    const notifySaved = await writeNotify(notify);
    const saved = await writeContent(content);
    if (!saved || !notifySaved) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true });
  }

  if (action === "test-mail") {
    const notify = sanitizeNotify(body.notify || {}, await readNotify());
    if (!notify) return json(422, { ok: false, error: "validation" });
    if (!notify.smtpPassword || !notify.smtpUser || !notify.mailTo) {
      const [gmail, yandexMail] = await Promise.all([smtpReachable("smtp.gmail.com", 465), smtpReachable("smtp.yandex.ru", 465)]);
      return json(200, { ok: false, error: "smtp_no_password", gmail, yandex: yandexMail });
    }
    try {
      await sendSmtp({
        host: notify.smtpHost,
        port: 465,
        user: notify.smtpUser,
        password: notify.smtpPassword,
        to: notify.mailTo,
        subject: "Проверка почты с сайта",
        text: "Если это письмо пришло, заявки с сайта будут приходить сюда.",
      });
      return json(200, { ok: true });
    } catch (error) {
      return json(200, { ok: false, error: smtpErrorCode(error) });
    }
  }

  if (action === "leads") {
    const leads = await listLeads();
    if (!leads) return json(502, { ok: false, error: "leads_unavailable" });
    return json(200, { ok: true, leads });
  }

  if (action === "delete") {
    if (!leadKeyOk(body.key)) return json(422, { ok: false, error: "validation" });
    const removed = await s3("DELETE", body.key);
    if (!removed.ok && removed.status !== 404) return json(502, { ok: false, error: "delete_failed" });
    return json(200, { ok: true });
  }

  return json(422, { ok: false, error: "validation" });
}

async function handleLead(event, method) {
  if (method === "OPTIONS") return empty(204);
  if (method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const body = readPayload(event);
  if (body.error === "bad_json") return json(400, { ok: false, error: "bad_json" });
  if (typeof body.company === "string" && body.company.trim() !== "") return json(200, { ok: true });

  const name = String(body.name ?? "").trim().slice(0, 100);
  const contact = String(body.contact ?? "").trim().slice(0, 120);
  const task = String(body.task ?? "").trim().slice(0, 2000);
  if (name.length < 2 || contact.length < 5 || task.length < 10) return json(422, { ok: false, error: "validation" });

  const objectKey = `leads/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const record = { name, contact, task, at: new Date().toISOString() };
  let saved = false;
  try {
    saved = await putLead(objectKey, record);
  } catch {
    saved = false;
  }
  if (!saved) return json(502, { ok: false, error: "save_failed" });

  let delivery = { mail: false, telegram: false, mailConfigured: false, telegramConfigured: false };
  try {
    delivery = await deliverLead(name, contact, task);
  } catch {
    delivery = { mail: false, telegram: false, mailConfigured: false, telegramConfigured: false };
  }
  try {
    await putLead(objectKey, { ...record, ...delivery });
  } catch {
    /* заявка уже лежит, отметка о письме не обязательна */
  }
  return json(200, { ok: true });
}

module.exports.handler = async function handler(event) {
  const method = String(event?.httpMethod || event?.requestContext?.httpMethod || "GET").toUpperCase();
  const route = routeOf(event);
  if (route === "content") return handleContent(method);
  if (route === "admin") return handleAdmin(event, method);
  return handleLead(event, method);
};

module.exports.sanitizeContent = sanitizeContent;
module.exports.sanitizeContacts = sanitizeContacts;
module.exports.sanitizeNotify = sanitizeNotify;
module.exports.smtpReachable = smtpReachable;
module.exports.sendSmtp = sendSmtp;
module.exports.passwordOk = passwordOk;
module.exports.leadKeyOk = leadKeyOk;
