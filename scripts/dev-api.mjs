/**
 * Локальный API для npm run dev.
 * Слушает только 127.0.0.1. Пароль — ADMIN_PASSWORD или local-admin.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRoot = path.join(root, "yandex/.local");
const contentFile = path.join(localRoot, "content/site.json");

fs.mkdirSync(path.dirname(contentFile), { recursive: true });
if (!fs.existsSync(contentFile)) {
  fs.copyFileSync(path.join(root, "yandex/lead/content.default.json"), contentFile);
}

const ownPassword = !process.env.ADMIN_PASSWORD;
process.env.LOCAL_ROOT = localRoot;
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "local-admin";

const require = createRequire(import.meta.url);
const { handler } = require("../yandex/lead/index.js");

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = url.pathname.startsWith("/api/content")
      ? "content"
      : url.pathname.startsWith("/api/admin")
        ? "admin"
        : url.pathname.startsWith("/api/lead")
          ? "lead"
          : url.pathname.startsWith("/api/guard")
            ? "guard"
            : "";
    const body = await readBody(req, 1_000_000);
    const result = await handler({
      httpMethod: req.method,
      headers: req.headers,
      body: body.toString("utf8"),
      isBase64Encoded: false,
      path: url.pathname,
      requestContext: { apiGateway: { operationContext: { route } } },
    });
    send(res, result.statusCode, result.headers, result.body);
  } catch {
    if (!res.headersSent) send(res, 500, { "Content-Type": "application/json; charset=utf-8" }, '{"ok":false}');
  }
});

const port = Number(process.env.PORT) || 8787;
server.listen(port, "127.0.0.1", () => {
  console.log(`Локальный API: http://127.0.0.1:${port}`);
  console.log("Админка откроется на http://127.0.0.1:4321/admin вместе с npm run dev");
  console.log(ownPassword ? "Пароль: local-admin" : "Пароль берётся из ADMIN_PASSWORD.");
});
