const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { handler, sanitizeContacts } = require("./index.js");

test("пустой контакт прячет кнопку, а половинный Max не проходит", () => {
  const empty = sanitizeContacts({ telegram: "", whatsapp: "", email: "", max: { label: "", url: "" } });
  assert.equal(empty.telegram.url, "");
  assert.equal(empty.whatsapp.url, "");
  assert.equal(empty.email.url, "");
  assert.equal(empty.max.url, "");
  assert.equal(sanitizeContacts({ telegram: "@devopsnsk", whatsapp: "", email: "", max: { label: "только", url: "" } }), null);
  const kept = sanitizeContacts({ telegram: "@devopsnsk", whatsapp: "+7 913 019-71-99", email: "devopsnskru@gmail.com", max: { label: "", url: "" } });
  assert.equal(kept.telegram.url, "https://t.me/devopsnsk");
  assert.equal(kept.max.url, "");
});

test("заявка получает номер, статус и заметку, жетон одноразовый", async () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    wait: process.env.GUARD_MIN_MS,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sajty-lead-"));
  process.env.LOCAL_ROOT = folder;
  process.env.ADMIN_PASSWORD = "test-password-1";
  process.env.GUARD_MIN_MS = "0";
  const password = "test-password-1";
  try {
    const call = (method, route, body, headers = {}) =>
      handler({
        httpMethod: method,
        headers,
        body: body ? JSON.stringify(body) : "",
        path: `/api/${route}`,
        requestContext: { apiGateway: { operationContext: { route } } },
      });

    fs.mkdirSync(path.join(folder, "leads"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "leads/2026-11-07T17-41-38-531Z.json"),
      JSON.stringify({ name: "Старая", contact: "+70000000000", task: "Без статуса и номера", at: "2026-11-07T17:41:38.531Z" }),
    );

    const early = await call("GET", "guard");
    const earlyToken = JSON.parse(early.body).token;
    process.env.GUARD_MIN_MS = "4000";
    const waited = await call("POST", "lead", {
      name: "Иван",
      contact: "+79130000001",
      task: "Нужен сайт для мастерской",
      guard: earlyToken,
    });
    assert.equal(waited.statusCode, 422);
    assert.equal(JSON.parse(waited.body).error, "wait");
    process.env.GUARD_MIN_MS = "0";

    const token = JSON.parse((await call("GET", "guard")).body).token;
    const created = await call("POST", "lead", {
      name: "Иван",
      contact: "+79130000001",
      task: "Нужен сайт для мастерской",
      guard: token,
    });
    assert.equal(created.statusCode, 200, created.body);
    const number = JSON.parse(created.body).number;
    assert.match(number, /^С-1001$/);

    const reused = await call("POST", "lead", {
      name: "Иван",
      contact: "+79130000002",
      task: "Повтор того же жетона не проходит",
      guard: token,
    });
    assert.equal(reused.statusCode, 422);
    assert.equal(JSON.parse(reused.body).error, "guard");

    const honey = await call("POST", "lead", {
      name: "Бот",
      contact: "+79130000003",
      task: "Это ловушка и её не должно быть в списке",
      company: "acme",
      guard: token,
    });
    assert.equal(honey.statusCode, 200);

    const listed = await call("POST", "admin", { action: "leads" }, { "x-admin-password": password });
    const leads = JSON.parse(listed.body).leads;
    assert.equal(leads.some((lead) => lead.task.includes("ловушка")), false);
    const fresh = leads.find((lead) => lead.number === number);
    const old = leads.find((lead) => lead.name === "Старая");
    assert.equal(fresh.status, "new");
    assert.equal(fresh.note, "");
    assert.equal(old.status, "new");
    assert.equal(old.number, "");

    const updated = await call(
      "POST",
      "admin",
      { action: "update-lead", key: fresh.key, status: "work", note: "Созвон в четверг" },
      { "x-admin-password": password },
    );
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(JSON.parse(updated.body).lead.status, "work");
    assert.equal(JSON.parse(updated.body).lead.note, "Созвон в четверг");

    const bad = await call(
      "POST",
      "admin",
      { action: "update-lead", key: fresh.key, status: "lost", note: "" },
      { "x-admin-password": password },
    );
    assert.equal(bad.statusCode, 422);

    const content = JSON.parse((await call("GET", "content")).body);
    assert.equal(content.telegramToken, undefined);
    assert.equal(content.smtpPassword, undefined);
  } finally {
    if (previous.root == null) delete process.env.LOCAL_ROOT;
    else process.env.LOCAL_ROOT = previous.root;
    if (previous.password == null) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.wait == null) delete process.env.GUARD_MIN_MS;
    else process.env.GUARD_MIN_MS = previous.wait;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("четыре заявки с одного контакта за день останавливают пятую", async () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    wait: process.env.GUARD_MIN_MS,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sajty-busy-"));
  process.env.LOCAL_ROOT = folder;
  process.env.ADMIN_PASSWORD = "test-password-1";
  process.env.GUARD_MIN_MS = "0";
  try {
    const call = (body) =>
      handler({
        httpMethod: body ? "POST" : "GET",
        headers: {},
        body: body ? JSON.stringify(body) : "",
        path: body ? "/api/lead" : "/api/guard",
        requestContext: { apiGateway: { operationContext: { route: body ? "lead" : "guard" } } },
      });
    let last = 0;
    for (let i = 0; i < 4; i += 1) {
      const token = JSON.parse((await call()).body).token;
      last = (await call({ name: "Анна", contact: "anna@example.com", task: "Нужна визитка и цены", guard: token })).statusCode;
    }
    assert.equal(last, 200);
    const token = JSON.parse((await call()).body).token;
    const blocked = await call({ name: "Анна", contact: "anna@example.com", task: "Пятая заявка уже лишняя", guard: token });
    assert.equal(blocked.statusCode, 429);
    assert.equal(JSON.parse(blocked.body).error, "busy");
  } finally {
    if (previous.root == null) delete process.env.LOCAL_ROOT;
    else process.env.LOCAL_ROOT = previous.root;
    if (previous.password == null) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.wait == null) delete process.env.GUARD_MIN_MS;
    else process.env.GUARD_MIN_MS = previous.wait;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("окно со скидкой видно гостю, сохранение сайта его не стирает, код пишется в заявку", async () => {
  const previous = {
    root: process.env.LOCAL_ROOT,
    password: process.env.ADMIN_PASSWORD,
    wait: process.env.GUARD_MIN_MS,
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sajty-popup-"));
  process.env.LOCAL_ROOT = folder;
  process.env.ADMIN_PASSWORD = "test-password-1";
  process.env.GUARD_MIN_MS = "0";
  const password = "test-password-1";
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, "content.default.json"), "utf8"));
  const site = { price: base.price, packages: base.packages, contacts: base.contacts };
  const discount = {
    id: "vesna",
    enabled: true,
    title: "Весенняя скидка",
    text: "Скидка приложится к заявке, если забрать код.",
    kind: "discount",
    mode: "percent",
    value: 10,
    code: "VESNA",
    delay: 0,
    repeat: "once",
  };
  try {
    const call = (method, route, body, headers = {}) =>
      handler({
        httpMethod: method,
        headers,
        body: body ? JSON.stringify(body) : "",
        path: `/api/${route}`,
        requestContext: { apiGateway: { operationContext: { route } } },
      });
    const admin = (body) => call("POST", "admin", body, { "x-admin-password": password });

    const created = await admin({ action: "save-popup", create: true, popup: discount });
    assert.equal(created.statusCode, 200, created.body);
    const quiet = await admin({
      action: "save-popup",
      create: true,
      popup: {
        id: "zima",
        enabled: false,
        title: "Зимнее",
        text: "Это окно выключено и на сайт не выходит.",
        kind: "message",
        delay: 4,
        repeat: "visit",
      },
    });
    assert.equal(quiet.statusCode, 200, quiet.body);

    const pub = JSON.parse((await call("GET", "content")).body);
    assert.deepEqual(pub.popups.map((popup) => popup.id), ["vesna"]);
    assert.equal(pub.telegramToken, undefined);

    const saved = await admin({ action: "save", content: site, notify: {} });
    assert.equal(saved.statusCode, 200, saved.body);
    const kept = JSON.parse((await admin({ action: "popups" })).body).popups;
    assert.deepEqual(kept.map((popup) => popup.id), ["vesna", "zima"]);

    const duplicate = await admin({
      action: "save-popup",
      create: true,
      popup: { ...discount, id: "osen", title: "Другое окно" },
    });
    assert.equal(duplicate.statusCode, 422);
    assert.equal(JSON.parse(duplicate.body).error, "popup_code");

    const token = JSON.parse((await call("GET", "guard")).body).token;
    const lead = await call("POST", "lead", {
      name: "Марина",
      contact: "+79130000021",
      task: "Хочу визитку и забираю скидку",
      guard: token,
      offer: "vesna",
    });
    assert.equal(lead.statusCode, 200, lead.body);
    const listed = JSON.parse((await admin({ action: "leads" })).body).leads;
    const fresh = listed.find((item) => item.contact === "+79130000021");
    assert.equal(fresh.offer.code, "VESNA");
    assert.equal(fresh.offer.kind, "discount");
    assert.equal(fresh.offer.value, 10);

    const otherToken = JSON.parse((await call("GET", "guard")).body).token;
    const plain = await call("POST", "lead", {
      name: "Олег",
      contact: "+79130000022",
      task: "Заявка без настоящего кода окна",
      guard: otherToken,
      offer: "NOPE",
    });
    assert.equal(plain.statusCode, 200, plain.body);
    const again = JSON.parse((await admin({ action: "leads" })).body).leads;
    assert.equal(again.find((item) => item.contact === "+79130000022").offer, null);
  } finally {
    if (previous.root == null) delete process.env.LOCAL_ROOT;
    else process.env.LOCAL_ROOT = previous.root;
    if (previous.password == null) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.wait == null) delete process.env.GUARD_MIN_MS;
    else process.env.GUARD_MIN_MS = previous.wait;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
