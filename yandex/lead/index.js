/**
 * Yandex Cloud Functions: заявка, публичный контент и админка.
 *
 * TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — попытка отправить заявку в Telegram.
 * LEADS_BUCKET, LEAD_ACCESS_KEY_ID, LEAD_SECRET_ACCESS_KEY — бакет заявок и контента.
 * ADMIN_PASSWORD — пароль страницы /admin. В ответ и в логи не попадает.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_CONTENT = JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8"));
const PACKAGE_IDS = ["visitka", "landing", "catalog"];
const PRICE_KEYS = ["visitka", "landing", "catalog", "texts", "setup", "support"];
const CONTENT_KEY = "content/site.json";

const json = (statusCode, body) => ({
  statusCode,
  isBase64Encoded: false,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
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
  return { price, packages };
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
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
}

async function saveLead(name, contact, task) {
  const objectKey = `leads/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const result = await s3("PUT", objectKey, {
    body: JSON.stringify({ name, contact, task, at: new Date().toISOString() }),
    contentType: "application/json",
  });
  return result.ok;
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

  if (action === "save") {
    const content = sanitizeContent(body.content);
    if (!content) return json(422, { ok: false, error: "validation" });
    const saved = await writeContent(content);
    if (!saved) return json(502, { ok: false, error: "save_failed" });
    return json(200, { ok: true });
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

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return json(503, { ok: false, error: "not_configured" });

  const body = readPayload(event);
  if (body.error === "bad_json") return json(400, { ok: false, error: "bad_json" });
  if (typeof body.company === "string" && body.company.trim() !== "") return json(200, { ok: true });

  const name = String(body.name ?? "").trim().slice(0, 100);
  const contact = String(body.contact ?? "").trim().slice(0, 120);
  const task = String(body.task ?? "").trim().slice(0, 2000);
  if (name.length < 2 || contact.length < 5 || task.length < 10) return json(422, { ok: false, error: "validation" });

  let saved = false;
  try {
    saved = await saveLead(name, contact, task);
  } catch {
    saved = false;
  }

  let sent = false;
  try {
    sent = await sendTelegram(token, chatId, ["Новая заявка с сайта", "", `Имя: ${name}`, `Связь: ${contact}`, "", task].join("\n"));
  } catch {
    sent = false;
  }

  if (saved || sent) return json(200, { ok: true });
  return json(502, { ok: false, error: "telegram_failed" });
}

module.exports.handler = async function handler(event) {
  const method = String(event?.httpMethod || event?.requestContext?.httpMethod || "GET").toUpperCase();
  const route = routeOf(event);
  if (route === "content") return handleContent(method);
  if (route === "admin") return handleAdmin(event, method);
  return handleLead(event, method);
};

module.exports.sanitizeContent = sanitizeContent;
module.exports.passwordOk = passwordOk;
module.exports.leadKeyOk = leadKeyOk;
