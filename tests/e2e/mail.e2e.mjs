/**
 * The email module against the local test stack (project grafito-e2e) with its imap-test Dovecot
 * (TLS from the test CA) and the mail-sync worker. Synthetic accounts and messages only. Not part
 * of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   node --test tests/e2e/mail.e2e.mjs
 *
 * Each run creates fresh "e2email-" members; the IMAP users are reset and seeded first.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { ImapFlow } from "imapflow";
import { AwsClient } from "aws4fetch";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const PASSWORD = "Prueba-Correo-2026";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:15432/grafito";
const SEED = new URL("./mail-seed.mjs", import.meta.url);
const stamp = Date.now();

async function query(text, values = []) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function until(check, label, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function seed(...args) {
  return execFileSync(process.execPath, [SEED.pathname.replace(/^\/([A-Z]:)/, "$1"), ...args], {
    encoding: "utf8",
    timeout: 600_000,
  });
}

async function member(name, role = "miembro") {
  const login = `e2email-${name}-${stamp}`;
  const id = `e2email-${randomUUID()}`;
  await query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [id, login, `${login}@grafito.app`],
  );
  await query(
    `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
     values ($1, $2, 'credential', $2, $3, now(), now())`,
    [randomUUID(), id, await hashPassword(PASSWORD)],
  );
  await query(`insert into app_user_role (user_id, role_id, login_name) values ($1, $3, $2)`, [
    id,
    login,
    role,
  ]);
  const token = `gft_${randomBytes(32).toString("base64url")}`;
  await query(
    `insert into api_token (id, user_id, name, prefix, token_hash) values ($1, $2, 'e2e', $3, $4)`,
    [randomUUID(), id, token.slice(0, 10), createHash("sha256").update(token).digest("hex")],
  );
  return { id, login, token };
}

async function signIn(browser, who) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 950 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  // Leaving a message being written asks to confirm; tests leave on purpose.
  page.on("dialog", (dialog) => void dialog.accept());
  page.setDefaultTimeout(60_000);
  await page.goto(`${base}/login`);
  const token = await page.evaluate(
    async ({ email, password }) =>
      (
        await fetch("/api/auth/sign-in/email", {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        })
      ).headers.get("set-auth-token"),
    { email: `${who.login}@grafito.app`, password: PASSWORD },
  );
  assert.ok(token, "signed in");
  await context.addInitScript(
    (value) => localStorage.setItem("grafito-auth.bearer-token", value),
    token,
  );
  return { context, page };
}

let nextId = 1;
async function mcp(token, name, args = {}) {
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const answer = await response.json();
  assert.ok(answer.result, `${name}: ${JSON.stringify(answer.error)}`);
  return { error: answer.result.isError, data: JSON.parse(answer.result.content[0].text) };
}

// What the test SMTP server (smtp-test, Mailpit) received, through its API.
const SMTP_API = (process.env.E2E_SMTP_API ?? "http://127.0.0.1:18025").replace(/\/+$/, "");

async function received(subject) {
  let found = null;
  await until(async () => {
    const list = await (
      await fetch(`${SMTP_API}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)
    ).json();
    found = list.messages?.[0] ?? null;
    return Boolean(found);
  }, `«${subject}» received by smtp-test`);
  const message = await (await fetch(`${SMTP_API}/api/v1/message/${found.ID}`)).json();
  const headers = await (await fetch(`${SMTP_API}/api/v1/message/${found.ID}/headers`)).json();
  return { message, headers };
}

/** The text/calendar part of a received message, decoded. */
async function calendarPart(message) {
  const unfold = (value) => value.replace(/\r?\n /g, "");
  for (const part of [...(message.Attachments ?? []), ...(message.Inline ?? [])]) {
    if (!/calendar/i.test(part.ContentType) && !/\.ics$/i.test(part.FileName ?? "")) continue;
    return unfold(
      await (await fetch(`${SMTP_API}/api/v1/message/${message.ID}/part/${part.PartID}`)).text(),
    );
  }
  return unfold(await (await fetch(`${SMTP_API}/api/v1/message/${message.ID}/raw`)).text());
}

async function smtpCount(subject) {
  const list = await (
    await fetch(`${SMTP_API}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)
  ).json();
  return list.messages?.length ?? 0;
}

// The test CalDAV server (caldav-test, Radicale) through 127.0.0.1:18443, TLS checked against the
// test CA. Ana's calendar «Trabajo» starts each run with one event repeated three days.
const CALDAV = {
  port: Number(process.env.E2E_CALDAV_PORT ?? 18443),
  user: "ana@prueba.test:Correo-Ana-2026",
};
const CALENDAR = "/ana@prueba.test/trabajo/";

function dav(method, path, body = "", headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: CALDAV.port,
        servername: "caldav-test",
        ca: readFileSync(new URL("../../.data/imap-test/certs/ca.crt", import.meta.url)),
        method,
        path,
        headers: {
          authorization: `Basic ${Buffer.from(CALDAV.user).toString("base64")}`,
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function davSeed() {
  await dav("DELETE", CALENDAR);
  const made = await dav(
    "MKCALENDAR",
    CALENDAR,
    `<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Trabajo</d:displayname></d:prop></d:set></c:mkcalendar>`,
    { "content-type": "application/xml" },
  );
  assert.equal(made.status, 201);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const put = await dav(
    "PUT",
    `${CALENDAR}guardia.ics`,
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//e2e//ES",
      "BEGIN:VEVENT",
      `UID:guardia-${stamp}@prueba.test`,
      `DTSTAMP:${day}T120000Z`,
      `DTSTART:${day}T150000Z`,
      `DTEND:${day}T160000Z`,
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Guardia diaria",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
    { "content-type": "text/calendar" },
  );
  assert.equal(put.status, 201);
}

/** Every event of Ana's «Trabajo» calendar as iCalendar text. */
async function davEvents() {
  const answer = await dav(
    "REPORT",
    CALENDAR,
    `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"/></c:filter></c:calendar-query>`,
    { depth: "1", "content-type": "application/xml" },
  );
  return [...answer.text.matchAll(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g)].map((match) =>
    match[0]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\r?\n /g, ""),
  );
}

describe("email module", () => {
  let browser;
  let ana;
  let beto;
  let page;
  let accountId;

  before(async () => {
    // The module on and a clean IMAP mailbox. imap-test is on the stack's private network and
    // trusted through MAIL_TRUSTED_HOSTS.
    await query(`update app_plugin set enabled = true where id = 'correo'`);
    seed("reset", "ana@prueba.test", "Correo-Ana-2026");
    seed("basic", "ana@prueba.test", "Correo-Ana-2026");
    ana = await member("ana");
    beto = await member("beto");
    browser = await playwright.chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
    ({ page } = await signIn(browser, ana));
  });
  after(async () => {
    await browser?.close();
  });

  test("the mail entry shows beside the trash, empty without accounts; setup lives in the Account", async () => {
    await page.goto(`${base}/`);
    const entry = page.locator('[data-ui="mail-entry"]');
    await entry.getByText("Correo electrónico").waitFor();
    await entry.click();
    await page.waitForURL(/\/mail\/?(\?|$)/);
    await page.locator('[data-ui="mail"][data-empty]').waitFor();
    assert.equal(await page.locator('[data-ui="mail-add"]').count(), 0);
    assert.equal(await page.locator('[data-ui="mail-list"]').count(), 0);
    // No administration of mail accounts any more.
    assert.equal(
      (await query(`select count(*)::int n from app_permission where key = 'mailbox.manage'`))[0].n,
      0,
    );
    await page.goto(`${base}/account`);
    await page.getByRole("button", { name: "Cuentas de correo" }).first().click();
    await page.locator('[data-ui="mail-add"]').waitFor();
    // Turned off in Extensions: the entry goes.
    await query(`update app_plugin set enabled = false where id = 'correo'`);
    const { context, page: fresh } = await signIn(browser, ana);
    await fresh.goto(`${base}/`);
    await fresh.getByText("Papelera", { exact: true }).waitFor();
    assert.equal(await fresh.locator('[data-ui="mail-entry"]').count(), 0);
    await context.close();
    await query(`update app_plugin set enabled = true where id = 'correo'`);
  });

  test("switching the extension shows and hides the entry without reloading the page", async () => {
    const admin = await member("admin", "admin");
    const { context, page: own } = await signIn(browser, admin);
    try {
      await own.goto(`${base}/`);
      const entry = own.locator('[data-ui="mail-entry"]');
      await entry.waitFor();
      // Administración → Extensiones, then back to the vault through the app's own links.
      await own.goto(`${base}/admin`);
      await own.getByRole("button", { name: "Extensiones" }).first().click();
      const toggle = own.locator('[data-extension="correo"]').getByRole("switch");
      await toggle.click();
      await own.waitForFunction(
        () =>
          document
            .querySelector('[data-extension="correo"] [role="switch"]')
            ?.getAttribute("aria-checked") === "false",
      );
      await own.locator('[data-ui="topbar"] a[href="/"]').first().click();
      await own.getByText("Papelera", { exact: true }).waitFor();
      assert.equal(await entry.count(), 0, "gone without a reload");
      await own.goto(`${base}/admin`);
      await own.getByRole("button", { name: "Extensiones" }).first().click();
      await toggle.click();
      await own.waitForFunction(
        () =>
          document
            .querySelector('[data-extension="correo"] [role="switch"]')
            ?.getAttribute("aria-checked") === "true",
      );
      await own.locator('[data-ui="topbar"] a[href="/"]').first().click();
      await entry.waitFor({ timeout: 10_000 });
    } finally {
      await context.close();
      await query(`update app_plugin set enabled = true where id = 'correo'`);
    }
  });

  test("T03, T38: a wrong password and an untrusted private server are refused", async () => {
    await page.goto(`${base}/account?section=mailboxes`);
    const form = page.locator('[data-ui="mail-add"]');
    await form.waitFor();
    await form.getByLabel("Dirección de correo").fill("ana@prueba.test");
    await form.getByLabel("Servidor IMAP").fill("imap-test");
    await form.getByLabel("Contraseña o contraseña de aplicación").fill("equivocada");
    await form.getByRole("button", { name: "Conectar" }).click();
    await form
      .getByRole("alert")
      .getByText(/rechazó el usuario o la contraseña/)
      .waitFor();
    // A server on a private network the server does not trust: refused before connecting.
    await form.getByLabel("Servidor IMAP").fill("10.20.30.40");
    await form.getByLabel("Contraseña o contraseña de aplicación").fill("Correo-Ana-2026");
    await form.getByRole("button", { name: "Conectar" }).click();
    await form
      .getByRole("alert")
      .getByText(/red privada/)
      .waitFor();
    for (const host of ["localhost", "169.254.169.254", "postgres"]) {
      await form.getByLabel("Servidor IMAP").fill(host);
      await form.getByRole("button", { name: "Conectar" }).click();
      await form.getByRole("alert").waitFor();
      assert.doesNotMatch(await form.getByRole("alert").innerText(), /rechazó el usuario/);
    }
    assert.equal(
      (await query(`select count(*)::int n from mail_account where user_id = $1`, [ana.id]))[0].n,
      0,
    );
  });

  test("T01, T10: the account connects and messages arrive progressively", async () => {
    const form = page.locator('[data-ui="mail-add"]');
    await form.getByLabel("Servidor IMAP").fill("imap-test");
    await form.getByLabel("Contraseña o contraseña de aplicación").fill("Correo-Ana-2026");
    await form.getByRole("button", { name: "Conectar" }).click();
    await page.locator('[data-ui="mail-account"]').waitFor();
    accountId = (await query(`select id from mail_account where user_id = $1`, [ana.id]))[0].id;
    await until(
      async () =>
        (
          await query(`select count(*)::int n from mail_message where account_id = $1`, [accountId])
        )[0].n >= 5,
      "messages synced",
    );
    await page.goto(`${base}/mail`);
    await page.locator('[data-ui="mail-list"] [data-message]').first().waitFor();
    const subjects = await page.locator('[data-ui="mail-list"] [data-message]').allInnerTexts();
    assert.ok(subjects.some((text) => text.includes("Informe con adjuntos")));
    // The whole history by default, like the mail server shows it.
    await until(
      async () =>
        (
          await query(
            `select count(*)::int n from mail_message where account_id = $1 and subject = 'Muy antiguo fuera de la ventana'`,
            [accountId],
          )
        )[0].n === 1,
      "the 90-day-old message too",
    );
    // Credentials never come back, and they are stored sealed.
    const row = (await query(`select secret from mail_account where id = $1`, [accountId]))[0];
    assert.doesNotMatch(row.secret, /Correo-Ana-2026/);
  });

  async function openMessage(subject) {
    await page.goto(`${base}/mail`);
    const row = page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: subject })
      .first();
    await row.click();
    await page.locator('[data-ui="mail-message"] h2').filter({ hasText: subject }).waitFor();
    return page.locator('[data-ui="mail-message"]');
  }

  async function syncNow() {
    const last = (
      await query(`select coalesce(last_sync_at, 0) as at from mail_account where id = $1`, [
        accountId,
      ])
    )[0].at;
    await query(`update mail_account set next_sync_at = 0 where id = $1`, [accountId]);
    await until(
      async () =>
        Number(
          (
            await query(`select coalesce(last_sync_at, 0) as at from mail_account where id = $1`, [
              accountId,
            ])
          )[0].at,
        ) > Number(last),
      "a sync",
      120_000,
    );
  }

  test("T19, T36, T37, T26: HTML is cleaned and sandboxed; trackers blocked; CID image shown", async () => {
    const view = await openMessage("HTML peligroso con imagen embebida");
    const frame = view.locator('iframe[data-ui="mail-body"]');
    await frame.waitFor();
    assert.equal(
      await frame.getAttribute("sandbox"),
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    // The CID image is fetched and the frame redrawn with its signed link.
    await until(
      async () => /\/api\/mail\/attachments\//.test((await frame.getAttribute("srcdoc")) ?? ""),
      "cid image",
      60_000,
    );
    const doc = (await frame.getAttribute("srcdoc")) ?? "";
    for (const bad of [
      "<script",
      "onerror",
      "onclick",
      "<form",
      "<iframe",
      "<svg",
      "javascript:",
      "tracker.example",
    ])
      assert.ok(!doc.toLowerCase().includes(bad), `no ${bad}`);
    assert.match(doc, /Content-Security-Policy/);
    assert.match(doc, /href="https:\/\/grafito\.example\/ok"[^>]*target="_blank"/);
    assert.notEqual(await page.title(), "pwned");
    await view.getByText(/Imágenes de internet bloqueadas: 1/).waitFor();
  });

  test("T20: plain text shows as text", async () => {
    const view = await openMessage("Texto plano de prueba");
    await view
      .locator('[data-ui="mail-text"]')
      .getByText(/quetzalcoatl/)
      .waitFor();
  });

  test("T21, T23: a PDF attachment opens in Grafito's viewer and downloads intact", async () => {
    const view = await openMessage("Informe con adjuntos");
    const item = view
      .locator('[data-ui="mail-attachments"] li')
      .filter({ hasText: "informe-trimestral.pdf" });
    await item.getByRole("button", { name: "Ver" }).click();
    await page.locator('div[data-page="1"] canvas').first().waitFor({ timeout: 90_000 });
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Descargar" }).click();
    const file = await (await download).path();
    const bytes = readFileSync(file);
    const stored = (
      await query(
        `select checksum, antivirus_status from mail_attachment where user_id = $1 and filename = 'informe-trimestral.pdf'`,
        [ana.id],
      )
    )[0];
    assert.equal(createHash("sha256").update(bytes).digest("hex"), stored.checksum);
    assert.equal(stored.antivirus_status, "clean");
    await page.keyboard.press("Escape");
  });

  test("T25: an infected attachment is blocked", async () => {
    const view = await openMessage("Archivo con virus de prueba");
    const item = view
      .locator('[data-ui="mail-attachments"] li')
      .filter({ hasText: "eicar.com.txt" });
    await item.getByRole("button", { name: "Ver" }).click();
    await item
      .locator('[data-ui="attachment-state"]')
      .getByText(/antivirus/)
      .waitFor({ timeout: 90_000 });
    const row = (
      await query(
        `select download_status, antivirus_status, storage_key from mail_attachment where user_id = $1 and filename = 'eicar.com.txt'`,
        [ana.id],
      )
    )[0];
    assert.deepEqual(row, {
      download_status: "blocked",
      antivirus_status: "infected",
      storage_key: null,
    });
  });

  test("T27, T28: an attachment and the message go into the vault with their provenance", async () => {
    const folder = (await mcp(ana.token, "create_portfolio", { name: "Correo archivado" })).data.id;
    const view = await openMessage("Informe con adjuntos");
    const item = view.locator('[data-ui="mail-attachments"] li').filter({ hasText: "notas.txt" });
    await item.getByRole("button", { name: "Guardar en Grafito" }).click();
    const dialog = page.locator('[data-ui="mail-archive"]');
    await dialog.getByLabel("Dónde").selectOption({ label: "Correo archivado" });
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await page
      .locator('[data-ui="toast"]')
      .getByText(/Guardado en Grafito/)
      .waitFor();
    const file = await query(
      `select portfolio_id from vault_doc where user_id = $1 and file_name = 'notas.txt'`,
      [ana.id],
    );
    assert.equal(file[0]?.portfolio_id, folder);
    // The whole message as a Markdown note, with the downloaded PDF next to it and linked.
    await view.getByRole("button", { name: "Archivar en Grafito" }).click();
    await dialog.getByLabel("Dónde").selectOption({ label: "Correo archivado" });
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await page.waitForURL(`${base}/`);
    const note = (
      await query(
        `select content, links_json from vault_doc where user_id = $1 and kind = 'markdown' and title = 'Informe con adjuntos'`,
        [ana.id],
      )
    )[0];
    assert.match(note.content, /\| De \| Ana Remitente \\<ana\.r@otro\.test\\> \|/);
    assert.match(note.content, /\| Message-ID \| \\<seed-/);
    assert.match(note.content, /\| Cuenta \| ana@prueba\.test \|/);
    assert.match(note.content, /informe trimestral/);
    assert.ok(JSON.parse(note.links_json).length >= 1, "linked to the saved attachments");
  });

  test("T29: the original message as .eml keeps its source", async () => {
    const view = await openMessage("Texto plano de prueba");
    await view.getByRole("button", { name: "Archivar en Grafito" }).click();
    const dialog = page.locator('[data-ui="mail-archive"]');
    await dialog.getByLabel("Mensaje original (.eml)").check();
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await page
      .locator('[data-ui="toast"]')
      .getByText(/El \.eml se está guardando/)
      .waitFor();
    const doc = await until(
      async () =>
        (
          await query(
            `select file_key, file_mime from vault_doc where user_id = $1 and file_name like '%.eml'`,
            [ana.id],
          )
        )[0],
      ".eml stored",
    );
    assert.equal(doc.file_mime, "message/rfc822");
    const ref = (
      await query(
        `select internet_message_id from mail_archive_reference where user_id = $1 and format = 'eml'`,
        [ana.id],
      )
    )[0];
    assert.match(ref.internet_message_id, /^<seed-/);
  });

  test("T11, T12, T24: new mail arrives incrementally, once, while the list is open", async () => {
    await page.goto(`${base}/mail`);
    const before = (
      await query(`select count(*)::int n from mail_message where account_id = $1`, [accountId])
    )[0].n;
    seed("one", "ana@prueba.test", "Correo-Ana-2026", "Llegada incremental");
    // A sync asked for several times at once is one job.
    for (let index = 0; index < 3; index += 1)
      await query(
        `insert into mail_job (id, user_id, account_id, kind, dedupe_key, run_after, created_at, updated_at)
         values ($1, $2, $3, 'sync', $4, 0, 0, 0) on conflict (dedupe_key) where state in ('queued', 'running') do nothing`,
        [randomUUID(), ana.id, accountId, `sync:${accountId}`],
      );
    await page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: "Llegada incremental" })
      .waitFor({ timeout: 90_000 });
    const after = (
      await query(`select count(*)::int n from mail_message where account_id = $1`, [accountId])
    )[0].n;
    assert.equal(after, before + 1);
    const copies = (
      await query(
        `select count(*)::int n from mail_message where account_id = $1 and subject = 'Llegada incremental'`,
        [accountId],
      )
    )[0].n;
    assert.equal(copies, 1);
  });

  test("T18, T30: a message deleted on the server leaves the list; its archived copy stays", async () => {
    seed("delete", "ana@prueba.test", "Correo-Ana-2026", "Texto plano de prueba");
    await query(`update mail_sync_state set reconciled_at = null where account_id = $1`, [
      accountId,
    ]);
    await syncNow();
    const live = await query(
      `select count(*)::int n from mail_message m join mail_message_location l on l.message_id = m.id
       where m.account_id = $1 and m.subject = 'Texto plano de prueba' and l.deleted_at is null`,
      [accountId],
    );
    assert.equal(live[0].n, 0);
    assert.equal(
      (
        await query(
          `select count(*)::int n from vault_doc where user_id = $1 and file_name like '%.eml' and not deleted`,
          [ana.id],
        )
      )[0].n,
      1,
    );
  });

  test("T15: a folder recreated on the server (new UIDVALIDITY) is fetched again safely", async () => {
    assert.match(seed("recreate", "ana@prueba.test", "Correo-Ana-2026", "Proyectos"), /recreated/);
    await syncNow();
    const rows = await query(
      `select m.subject, l.deleted_at is null as live from mail_message m join mail_message_location l on l.message_id = m.id
       join mail_folder f on f.id = l.folder_id where f.account_id = $1 and f.remote_id = 'Proyectos'`,
      [accountId],
    );
    assert.ok(rows.some((row) => row.subject === "Tras recrear la carpeta" && row.live));
    assert.ok(
      rows.filter((row) => row.subject === "Carpeta personalizada").every((row) => !row.live),
    );
  });

  test("T34, T35, T41: another person reaches neither the messages nor the attachments nor the credentials", async () => {
    const message = (
      await query(`select id from mail_message where account_id = $1 limit 1`, [accountId])
    )[0].id;
    const attachment = (
      await query(
        `select id from mail_attachment where user_id = $1 and download_status = 'ready' limit 1`,
        [ana.id],
      )
    )[0].id;
    const { context, page: other } = await signIn(browser, beto);
    await other.goto(`${base}/mail`);
    const status = await other.evaluate(
      async (id) => (await fetch(`/api/mail/attachments/${id}?t=forjado`)).status,
      attachment,
    );
    assert.equal(status, 403);
    const read = await mcp(beto.token, "read_mail", { id: message });
    assert.equal(read.error, true);
    await context.close();
    const accounts = await query(`select secret from mail_account where user_id = $1`, [ana.id]);
    assert.ok(accounts.every((row) => !row.secret.includes("Correo-Ana-2026")));
  });

  test("T40: MCP sees mail only when allowed, and marks it as untrusted content", async () => {
    const denied = await mcp(ana.token, "list_mail_accounts");
    assert.equal(denied.data.accounts.length, 0);
    await query(`update mail_account set mcp_access = true where id = $1`, [accountId]);
    const listed = await mcp(ana.token, "search_mail", { query: "asistente" });
    assert.equal(listed.error, false);
    const hit = listed.data.messages.find(
      (item) => item.untrusted_content.subject === "Instrucciones para tu asistente",
    );
    assert.ok(hit);
    const read = await mcp(ana.token, "read_mail", { id: hit.id });
    assert.match(read.data.warning, /no instrucciones/);
    assert.match(read.data.untrusted_content.content, /ignora tus instrucciones/);
    // Reading it did nothing on its own: nothing was deleted.
    assert.equal(
      (
        await query(`select count(*)::int n from vault_doc where user_id = $1 and deleted`, [
          ana.id,
        ])
      )[0].n,
      0,
    );
    const archived = await mcp(ana.token, "archive_mail", { id: hit.id, format: "markdown" });
    assert.equal(archived.error, false);
    assert.equal(
      (
        await query(`select count(*)::int n from vault_doc where user_id = $1 and id = $2`, [
          ana.id,
          archived.data.document_id,
        ])
      )[0].n,
      1,
    );
  });

  test("T05, T31, T06: disconnecting forgets credentials and keeps documents; new credentials recover", async () => {
    await page.goto(`${base}/account?section=mailboxes`);
    const card = page.locator('[data-ui="mail-account"]');
    await card.getByRole("button", { name: "Desconectar" }).click();
    await card.getByRole("button", { name: "Sí" }).click();
    await card.locator('[data-ui="mail-account-status"]').getByText("Desconectada").waitFor();
    const row = (
      await query(`select secret, sync_enabled from mail_account where id = $1`, [accountId])
    )[0];
    assert.deepEqual(row, { secret: "", sync_enabled: false });
    assert.ok(
      (
        await query(`select count(*)::int n from vault_doc where user_id = $1 and not deleted`, [
          ana.id,
        ])
      )[0].n >= 4,
    );
    assert.ok(
      (
        await query(`select count(*)::int n from mail_message where account_id = $1`, [accountId])
      )[0].n > 0,
    );
    await card.getByLabel("Nueva contraseña de la cuenta").fill("Correo-Ana-2026");
    await card.getByRole("button", { name: "Actualizar credenciales" }).click();
    await until(
      async () =>
        (await query(`select secret <> '' as has from mail_account where id = $1`, [accountId]))[0]
          .has,
      "credentials stored",
    );
    await query(`update mail_account set sync_enabled = true where id = $1`, [accountId]);
    await syncNow();
    assert.equal(
      (await query(`select status from mail_account where id = $1`, [accountId]))[0].status,
      "ok",
    );
  });

  test("T51: SMTP for sending is set per account, with the same server checks", async () => {
    await page.goto(`${base}/account?section=mailboxes`);
    const form = page.locator('[data-ui="mail-smtp"]');
    await form.getByLabel("Servidor SMTP (envío)").fill("smtp-test");
    await form.getByLabel("Puerto SMTP").selectOption("587");
    await form.getByRole("button", { name: "Guardar envío" }).click();
    await until(
      async () =>
        (await query(`select smtp_host from mail_account where id = $1`, [accountId]))[0]
          .smtp_host === "smtp-test",
      "SMTP saved",
    );
  });

  async function compose() {
    await page.goto(`${base}/mail`);
    await page.getByRole("button", { name: "Redactar" }).click();
    return page.locator('[data-ui="mail-compose"]');
  }

  test("T52, T53: a message goes out with documents from the vault and from a share, and lands in Sent", async () => {
    // Ana's own note and the PDF saved in T27; a note Beto shares with her (read only).
    await mcp(ana.token, "create_note", {
      title: "Nota para enviar",
      content: "# Acta\n\nContenido de la nota enviada desde Grafito.",
    });
    const folder = await mcp(beto.token, "create_portfolio", { name: "Compartida correo" });
    await mcp(beto.token, "create_note", {
      title: "Nota compartida correo",
      content: "Texto que Beto comparte.",
      portfolio_id: folder.data.id,
    });
    const shareId = `e2email-share-${stamp}`;
    await query(
      `insert into share_item (id, owner_id, kind, target_id, title, visibility, access)
       values ($1, $2, 'portfolio', $3, 'Compartida correo', 'shared', 'read')`,
      [shareId, beto.id, folder.data.id],
    );
    await query(`insert into share_grant (share_id, user_id, granted_at) values ($1, $2, $3)`, [
      shareId,
      ana.id,
      Date.now(),
    ]);
    const subject = `Envio con adjuntos ${stamp}`;
    const form = await compose();
    await form.getByLabel("Para").fill("Destino Uno <destino@otro.test>, copia2@otro.test");
    await form.getByLabel("Asunto").fill(subject);
    await form.getByLabel("Mensaje").fill("Hola,\n\nVan los documentos.\n");
    await form.getByRole("button", { name: "Adjuntar desde Grafito" }).click();
    const picker = page.locator('[data-ui="mail-vault-picker"]');
    // Browse the Carpeta Personal: the note at its root.
    await picker.locator('[data-doc="Nota para enviar"] input').check();
    // Search reaches the PDF saved inside a portfolio.
    await picker.getByLabel("Buscar en Grafito").fill("informe-trimestral");
    await picker.locator('[data-doc*="informe-trimestral"] input').first().check();
    await picker.getByLabel("Buscar en Grafito").fill("");
    // The share, opened from its own place.
    await picker.getByRole("button", { name: /^Compartida correo · / }).click();
    await picker.getByRole("button", { name: "Compartida correo", exact: true }).click();
    await picker.locator('[data-doc="Nota compartida correo"] input').check();
    await picker.getByRole("button", { name: "Adjuntar (3)" }).click();
    assert.equal(await form.locator('[data-ui="mail-compose-files"] > span').count(), 3);
    await form.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByText("Mensaje enviado.").waitFor();

    const { message } = await received(subject);
    const names = message.Attachments.map((item) => item.FileName).sort();
    assert.deepEqual(names, [
      "Nota compartida correo.md",
      "Nota para enviar.md",
      "informe-trimestral.pdf",
    ]);
    assert.deepEqual(message.To.map((item) => item.Address).sort(), [
      "copia2@otro.test",
      "destino@otro.test",
    ]);
    assert.equal(message.From.Address, "ana@prueba.test");
    assert.match(message.Text, /Van los documentos/);
    const pdf = message.Attachments.find((item) => item.FileName === "informe-trimestral.pdf");
    const bytes = Buffer.from(
      await (
        await fetch(`${SMTP_API}/api/v1/message/${message.ID}/part/${pdf.PartID}`)
      ).arrayBuffer(),
    );
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    // The copy in the server's Sent folder comes back with the next sync.
    await until(
      async () =>
        (
          await query(
            `select count(*)::int n from mail_message m
             join mail_message_location l on l.message_id = m.id
             join mail_folder f on f.id = l.folder_id
             where m.account_id = $1 and m.subject = $2 and f.special_use = 'sent'`,
            [accountId, subject],
          )
        )[0].n === 1,
      "the copy in Sent",
      120_000,
    );
    const audit = await query(
      `select detail from audit_event where action = 'mail.send' and outcome = 'ok' and target = $1 order by at desc limit 1`,
      [accountId],
    );
    assert.match(audit[0].detail, /2 destinatarios, adjuntos de Grafito/);
  });

  test("T54: a reply keeps the thread and Bcc stays out of the message", async () => {
    const view = await openMessage("Informe con adjuntos");
    const original = (
      await query(
        `select internet_message_id from mail_message where account_id = $1 and subject = 'Informe con adjuntos'`,
        [accountId],
      )
    )[0].internet_message_id;
    await view.getByRole("button", { name: "Responder", exact: true }).click();
    const form = page.locator('[data-ui="mail-compose"]');
    assert.equal(
      await form.locator('[data-recipients="Para"]').getAttribute("data-value"),
      "Ana Remitente <ana.r@otro.test>, ",
    );
    // The chip shows the name; the address only on a double click.
    const chip = form.locator('[data-recipients="Para"] [data-ui="recipient"]').first();
    assert.equal((await chip.innerText()).trim(), "Ana Remitente");
    await chip.dblclick();
    await chip.locator('[data-ui="recipient-address"]').getByText("ana.r@otro.test").waitFor();
    assert.equal(await form.getByLabel("Asunto").inputValue(), "Re: Informe con adjuntos");
    // The original shows below the text, as in Outlook: its header block and its content.
    const quoted = page.locator('[data-ui="mail-quoted"]').last();
    await quoted.getByText("Asunto:").waitFor();
    assert.match(await quoted.innerText(), /De:\s*Ana Remitente <ana\.r@otro\.test>/);
    assert.doesNotMatch(await form.getByLabel("Mensaje").inputValue(), /^>/m, "no «>» quoting");
    await form.getByRole("button", { name: "CC y CCO" }).click();
    await form.getByLabel("CCO").fill("oculto@otro.test");
    await form.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByText("Mensaje enviado.").waitFor();
    const { message, headers } = await received("Re: Informe con adjuntos");
    assert.equal(headers["In-Reply-To"]?.[0], original);
    // Sent with the original after the text, in the text and HTML parts.
    assert.match(
      message.Text,
      /________________________________\s*\nDe: Ana Remitente <ana\.r@otro\.test>/,
    );
    assert.match(
      message.Text,
      /Asunto: Informe con adjuntos[\s\S]*Te adjunto el informe trimestral/,
    );
    assert.match(message.HTML, /<b>De:<\/b> Ana Remitente &lt;ana\.r@otro\.test&gt;/);
    assert.match(message.HTML, /informe trimestral/);
    // Delivered to the Bcc address (Mailpit lists it from the envelope), but the message itself,
    // and so the copy kept in Sent, does not name it.
    assert.ok(
      message.Bcc.some((item) => item.Address === "oculto@otro.test"),
      "delivered to Bcc",
    );
    await syncNow();
    const copy = await query(
      `select bcc_json from mail_message where account_id = $1 and subject = 'Re: Informe con adjuntos'`,
      [accountId],
    );
    assert.equal(copy.length, 1);
    const bcc = copy[0].bcc_json;
    assert.deepEqual(typeof bcc === "string" ? JSON.parse(bcc) : bcc, []);
  });

  test("T55: sending is refused for internal SMTP hosts, other people's documents and a server that does not answer", async () => {
    const subject = `No debe salir ${stamp}`;
    const attempt = async () => {
      const form = await compose();
      await form.getByLabel("Para").fill("destino@otro.test");
      await form.getByLabel("Asunto").fill(subject);
      await form.getByRole("button", { name: "Enviar", exact: true }).click();
      await form.getByRole("alert").waitFor();
      return form.getByRole("alert").innerText();
    };
    await query(`update mail_account set smtp_host = '169.254.169.254' where id = $1`, [accountId]);
    assert.match(await attempt(), /no se puede usar/);
    await query(`update mail_account set smtp_host = 'postgres' where id = $1`, [accountId]);
    assert.match(await attempt(), /servicio interno|red privada/);
    await query(`update mail_account set smtp_host = 'smtp-test', smtp_port = 465 where id = $1`, [
      accountId,
    ]);
    assert.match(await attempt(), /rechazó la conexión|no respondió/);
    await query(`update mail_account set smtp_port = 587 where id = $1`, [accountId]);
    assert.equal(await smtpCount(subject), 0);
    // A document that is not Ana's: neither listed nor sendable.
    const hidden = await mcp(beto.token, "create_note", { title: "Privada de Beto", content: "x" });
    const form = await compose();
    await form.getByRole("button", { name: "Adjuntar desde Grafito" }).click();
    const picker = page.locator('[data-ui="mail-vault-picker"]');
    await picker.getByLabel("Buscar en Grafito").fill("Privada de Beto");
    await picker
      .getByText("Cargando…")
      .waitFor({ state: "detached" })
      .catch(() => undefined);
    await page.waitForTimeout(800);
    assert.equal(await picker.locator('[data-doc="Privada de Beto"]').count(), 0);
    assert.ok(hidden.data.id);
  });
  test("T56: the account's signature goes below new messages and above quoted replies", async () => {
    // The signature lives in the mail screen's Preferencias.
    await page.goto(`${base}/mail`);
    await page.getByRole("button", { name: "Opciones del correo" }).click();
    await page
      .locator('[data-ui="mail-settings-menu"]')
      .getByRole("menuitem", { name: "Preferencias" })
      .click();
    const prefs = page.locator('[data-ui="mail-preferences"]');
    await prefs.getByLabel("Firma").fill("Ana Prueba\nUnidad de pruebas");
    await prefs.getByRole("button", { name: "Guardar" }).click();
    await until(
      async () =>
        (await query(`select signature from mail_account where id = $1`, [accountId]))[0]
          .signature === "Ana Prueba\nUnidad de pruebas",
      "signature saved",
    );
    const form = await compose();
    assert.equal(
      await form.getByLabel("Mensaje").inputValue(),
      "\n\n-- \nAna Prueba\nUnidad de pruebas",
    );
    const subject = `Con firma ${stamp}`;
    await form.getByLabel("Para").fill("destino@otro.test");
    await form.getByLabel("Asunto").fill(subject);
    await form.getByLabel("Mensaje").press("Control+Home");
    await form.getByLabel("Mensaje").type("Texto del mensaje.");
    await form.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByText("Mensaje enviado.").waitFor();
    const { message } = await received(subject);
    assert.match(
      message.Text,
      /Texto del mensaje\.\s*\n\s*-- \s*\nAna Prueba\s*\nUnidad de pruebas/,
    );
    // A reply: the signature is in the text, the original below it.
    const view = await openMessage("Informe con adjuntos");
    await view.getByRole("button", { name: "Responder", exact: true }).click();
    const reply = page.locator('[data-ui="mail-compose"]');
    assert.match(await reply.getByLabel("Mensaje").inputValue(), /-- \nAna Prueba/);
    await page.locator('[data-ui="mail-quoted"]').getByText("Asunto:").waitFor();
  });

  test("T57: recipients are found by name in contacts and in the Zimbra directory", async () => {
    await page.goto(`${base}/account?section=mailboxes`);
    const web = page.locator('[data-ui="mail-web"]');
    await web.locator("summary").click();
    await web.getByLabel("Servidor web").fill("zimbra-test");
    await web.getByRole("button", { name: "Guardar" }).click();
    await until(
      async () =>
        (await query(`select web_host from mail_account where id = $1`, [accountId]))[0]
          .web_host === "zimbra-test",
      "web host saved",
    );
    const form = await compose();
    const to = form.getByLabel("Para");
    await to.fill("rodd");
    const list = form.locator('[data-ui="mail-recipients"]');
    await list.getByText("Roddy Andrade").waitFor();
    assert.match(await list.innerText(), /Directorio/);
    await to.press("Enter");
    const field = form.locator('[data-recipients="Para"]');
    assert.equal(
      await field.getAttribute("data-value"),
      "Roddy Andrade <roddy.andrade@prueba.test>, ",
    );
    assert.equal(await to.inputValue(), "");
    await field.locator('[data-ui="recipient"]').getByText("Roddy Andrade").waitFor();
    assert.equal(await field.locator('[data-ui="recipient-address"]').count(), 0, "address hidden");
    // Then someone already seen in mail, by part of the address.
    await to.pressSequentially("ana.r");
    await list.getByText("ana.r@otro.test").waitFor();
    assert.match(await list.innerText(), /Contactos/);
    await list.getByText("ana.r@otro.test").click();
    assert.match(
      await field.getAttribute("data-value"),
      /^Roddy Andrade <roddy\.andrade@prueba\.test>, .*ana\.r@otro\.test>?, $/,
    );
    assert.equal(
      (await query(`select directory from mail_account where id = $1`, [accountId]))[0].directory,
      "zimbra",
    );
    // A person not in the directory or contacts: nothing suggested.
    await to.fill("zzzz");
    assert.equal(await field.locator('[data-ui="recipient"]').count(), 2, "chips kept");
    await page.waitForTimeout(700);
    assert.equal(await list.count(), 0);
  });

  test("T58: files from the computer: only attached, or attached and kept in the vault", async () => {
    const folder = (await mcp(ana.token, "create_portfolio", { name: "Adjuntos guardados" })).data
      .id;
    const subject = `Desde el equipo ${stamp}`;
    const form = await compose();
    await form.getByLabel("Para").fill("destino@otro.test");
    await form.getByLabel("Asunto").fill(subject);
    // «Desde el equipo» picks a file: it is only attached, no question asked.
    await form.locator('input[type="file"]').setInputFiles({
      name: "solo-adjunto.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("solo para el correo"),
    });
    await form.locator('[data-attachment="solo-adjunto.txt"][data-status="ready"]').waitFor();
    assert.equal(
      await page.locator('[data-ui="overlay"]').count(),
      0,
      "no window: it is written in its tab",
    );
    // Dragging files over the message turns its body into two drop zones, like Outlook.
    await form.getByLabel("Guardar en").selectOption({ label: "Adjuntos guardados" });
    await form.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "guardar-tambien.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    });
    const zones = form.locator('[data-ui="mail-drop-zones"]');
    await zones.waitFor();
    assert.match(
      await zones.innerText(),
      /Guardar en Grafito y adjuntar[\s\S]*Adjuntos guardados[\s\S]*Adjuntar archivos/,
    );
    await zones.locator('[data-ui="mail-drop-save"]').evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(
        new File(["guardado en la boveda"], "guardar-tambien.txt", { type: "text/plain" }),
      );
      element.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    });
    await zones.waitFor({ state: "detached" });
    await form.locator('[data-attachment="guardar-tambien"]').waitFor();
    const saved = await query(
      `select id, portfolio_id, file_key from vault_doc where user_id = $1 and file_name = 'guardar-tambien.txt'`,
      [ana.id],
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].portfolio_id, folder);
    await form.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByText("Mensaje enviado.").waitFor();
    const { message } = await received(subject);
    assert.deepEqual(message.Attachments.map((item) => item.FileName).sort(), [
      "guardar-tambien.txt",
      "solo-adjunto.txt",
    ]);
    const only = message.Attachments.find((item) => item.FileName === "solo-adjunto.txt");
    const body = await (
      await fetch(`${SMTP_API}/api/v1/message/${message.ID}/part/${only.PartID}`)
    ).text();
    assert.equal(body, "solo para el correo");
    // Only the kept file is a document; the other one is not in the vault.
    assert.equal(
      (
        await query(
          `select count(*)::int n from vault_doc where user_id = $1 and file_name = 'solo-adjunto.txt'`,
          [ana.id],
        )
      )[0].n,
      0,
    );
  });

  test("T59: the Agenda reads the CalDAV calendars, expands repetitions, and creates, edits and deletes events", async () => {
    await davSeed();
    await page.goto(`${base}/account?section=mailboxes`);
    const web = page.locator('[data-ui="mail-web"]');
    await web.locator("summary").click();
    await web.getByLabel("Dirección CalDAV").fill("https://caldav-test:8443/.well-known/caldav");
    await web.getByRole("button", { name: "Guardar" }).click();
    await until(
      async () =>
        (await query(`select caldav_url from mail_account where id = $1`, [accountId]))[0]
          .caldav_url !== "",
      "CalDAV address saved",
    );
    await page.goto(`${base}/mail`);
    await page.locator('[data-ui="mail-agenda-entry"]').click();
    const agenda = page.locator('[data-ui="mail-agenda"]');
    await agenda.locator("label", { hasText: "Trabajo" }).waitFor();
    // The daily event seeded on the server: three occurrences.
    await until(
      async () => (await agenda.locator('[data-event="Guardia diaria"]').count()) === 3,
      "three occurrences",
      30_000,
    );
    // A new event with a guest.
    const title = `Reunión de prueba ${stamp}`;
    await agenda.getByRole("button", { name: "Nuevo evento" }).click();
    const form = page.locator('[data-ui="agenda-form"]');
    await form.getByLabel("Título").fill(title);
    await form.getByLabel("Hora de inicio").fill("10:00");
    await form.getByLabel("Hora de fin").fill("11:00");
    await form.getByLabel("Lugar").fill("Sala 2");
    await form.getByLabel("Invitados").fill("carlos.mena@prueba.test");
    await form.getByRole("button", { name: "Guardar" }).click();
    await agenda.locator(`[data-event="${title}"]`).waitFor();
    let stored = await davEvents();
    let ics = stored.find((item) => item.includes(title));
    assert.ok(ics, "stored on the CalDAV server");
    assert.match(ics, /LOCATION:Sala 2/);
    assert.match(ics, /ATTENDEE[^:]*:mailto:carlos\.mena@prueba\.test/i);
    assert.match(ics, /ORGANIZER[^:]*:mailto:ana@prueba\.test/i);
    // Edit it.
    await agenda.locator(`[data-event="${title}"]`).click();
    await page.locator('[data-ui="agenda-event"]').getByRole("button", { name: "Editar" }).click();
    await form.getByLabel("Título").fill(`${title} (cambiada)`);
    await form.getByRole("button", { name: "Guardar" }).click();
    await agenda.locator(`[data-event="${title} (cambiada)"]`).waitFor();
    stored = await davEvents();
    ics = stored.find((item) => item.includes(title));
    assert.match(ics, /SUMMARY:Reunión de prueba \d+ \(cambiada\)/);
    assert.match(ics, /SEQUENCE:1/);
    // Repeating events are read only here.
    await agenda.locator('[data-event="Guardia diaria"]').first().click();
    const detail = page.locator('[data-ui="agenda-event"]');
    await detail
      .getByText("Guardia diaria")
      .first()
      .waitFor({ state: "attached" })
      .catch(() => undefined);
    assert.equal(await detail.getByRole("button", { name: "Editar" }).count(), 0);
    // Escape closes it, as a click outside does.
    await page.keyboard.press("Escape");
    await page.locator('[data-ui="overlay"]').waitFor({ state: "detached" });
    // Delete the new one.
    await agenda.locator(`[data-event="${title} (cambiada)"]`).click();
    await detail.getByRole("button", { name: "Borrar" }).click();
    await detail.getByRole("button", { name: "Sí" }).click();
    await agenda.locator(`[data-event="${title} (cambiada)"]`).waitFor({ state: "detached" });
    stored = await davEvents();
    assert.ok(!stored.some((item) => item.includes(title)), "deleted on the server");
  });
  /** The account's Drafts folder on the IMAP server itself (what Zimbra shows). */
  async function serverDraft(subject) {
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: Number(process.env.MAIL_TEST_PORT || 1993),
      secure: true,
      servername: "imap-test",
      tls: { ca: [readFileSync(new URL("../../.data/imap-test/certs/ca.crt", import.meta.url))] },
      auth: { user: "ana@prueba.test", pass: "Correo-Ana-2026" },
      logger: false,
    });
    await client.connect();
    try {
      await client.mailboxOpen("Drafts");
      const uids = await client.search({ subject }, { uid: true });
      if (!uids?.length) return null;
      const message = await client.fetchOne(
        String(uids.at(-1)),
        { source: true, flags: true },
        { uid: true },
      );
      return { source: message.source.toString("utf8"), flags: [...message.flags] };
    } finally {
      await client.logout();
    }
  }

  const s3 = new AwsClient({
    accessKeyId: "grafito",
    secretAccessKey: process.env.E2E_S3_SECRET ?? "grafito-secret",
    service: "s3",
    region: "us-east-1",
  });
  const S3 = (process.env.E2E_S3 ?? "http://127.0.0.1:19000/grafito").replace(/\/+$/, "");

  test("T60: a red flag on every message, «Fichados», and the right-click menu with tabs", async () => {
    await page.goto(`${base}/mail`);
    const row = page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: "HTML peligroso con imagen embebida" })
      .first();
    await row.locator('[data-ui="mail-flag"]').click();
    await until(
      async () =>
        (
          await query(
            `select coalesce(local_flagged, remote_flagged) as flagged from mail_message where account_id = $1 and subject = 'HTML peligroso con imagen embebida'`,
            [accountId],
          )
        )[0].flagged === true,
      "flagged",
    );
    assert.equal(await row.getAttribute("data-flagged"), "");
    assert.equal(await page.locator('[data-ui="overlay"]').count(), 0, "no menu opened to flag");
    await page.getByRole("button", { name: "Fichados" }).click();
    await page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: "HTML peligroso con imagen embebida" })
      .waitFor();
    // Right click: open in a new tab, open, mark unread, reply.
    await page.goto(`${base}/mail`);
    const menu = page.locator('[data-ui="mail-row-menu"]');
    const rows = page.locator('[data-ui="mail-list"] [data-message]');
    await rows.filter({ hasText: "Informe con adjuntos" }).first().click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Abrir en una nueva pestaña" }).click();
    await page
      .locator('[data-ui="mail-tab"]')
      .filter({ hasText: "Informe con adjuntos" })
      .waitFor();
    await rows
      .filter({ hasText: "HTML peligroso con imagen embebida" })
      .first()
      .click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Abrir", exact: true }).click();
    await page
      .locator('[data-ui="mail-tab"]')
      .filter({ hasText: "HTML peligroso con imagen embebida" })
      .waitFor();
    assert.equal(await page.locator('[data-ui="mail-tab"]').count(), 2);
    await rows
      .filter({ hasText: "HTML peligroso con imagen embebida" })
      .first()
      .click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Marcar como no leído" }).click();
    await until(
      async () =>
        (
          await query(
            `select coalesce(local_seen, remote_seen) as seen from mail_message where account_id = $1 and subject = 'HTML peligroso con imagen embebida'`,
            [accountId],
          )
        )[0].seen === false,
      "marked unread",
    );
    await rows.filter({ hasText: "Informe con adjuntos" }).first().click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Responder", exact: true }).click();
    const reply = page.locator('[data-ui="mail-compose"]').last();
    await reply.waitFor();
    assert.equal(await reply.getByLabel("Asunto").inputValue(), "Re: Informe con adjuntos");
    // The message is written in its tab of the reading pane, not in a window.
    assert.equal(await page.locator('[data-ui="overlay"]').count(), 0);
    assert.ok((await page.locator('[data-ui="mail-tab"][data-compose]').count()) >= 1);
  });

  test("T61: closing a message being written asks; «Sí» keeps it in Drafts on the server, «No» throws it away", async () => {
    await page.goto(`${base}/mail`);
    // Without changes it closes without asking.
    await page.getByRole("button", { name: "Redactar" }).click();
    let tab = page.locator('[data-ui="mail-tab"][data-compose]').last();
    await tab.getByRole("button", { name: /^Cerrar/ }).click();
    await tab.waitFor({ state: "detached" });
    // Kept as a draft, with recipients and attachments.
    const subject = `Borrador ${stamp}`;
    await page.getByRole("button", { name: "Redactar" }).click();
    const form = page.locator('[data-ui="mail-compose"]').last();
    await form.getByLabel("Para").fill("destino@otro.test");
    await form.getByRole("button", { name: "CC y CCO" }).click();
    await form.getByLabel("CC", { exact: true }).fill("copia@otro.test");
    await form.getByLabel("Asunto").fill(subject);
    await form.getByLabel("Mensaje").press("Control+Home");
    await form.getByLabel("Mensaje").type("Texto del borrador.");
    await form.locator('input[type="file"]').setInputFiles({
      name: "borrador.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("adjunto del borrador"),
    });
    await form.locator('[data-attachment="borrador.txt"][data-status="ready"]').waitFor();
    tab = page.locator('[data-ui="mail-tab"]').filter({ hasText: subject });
    await tab.getByRole("button", { name: /^Cerrar/ }).click();
    const ask = page.locator('[data-ui="mail-close-draft"]');
    await ask.getByText("¿Desea guardarlo como borrador?").waitFor();
    await ask.getByRole("button", { name: "Sí" }).click();
    await tab.waitFor({ state: "detached" });
    await page.getByText("Borrador guardado.").waitFor();
    const draft = await serverDraft(subject);
    assert.ok(draft, "in the server's Drafts");
    assert.ok(draft.flags.includes("\\Draft"));
    assert.match(draft.source, /^To: destino@otro\.test/m);
    assert.match(draft.source, /^Cc: copia@otro\.test/m);
    assert.match(draft.source, /filename="?borrador\.txt"?/);
    assert.match(draft.source, /Texto del borrador\./);
    // Back in Grafito's Borradores after the sync.
    await until(
      async () =>
        (
          await query(
            `select count(*)::int n from mail_message m
             join mail_message_location l on l.message_id = m.id
             join mail_folder f on f.id = l.folder_id
             where m.account_id = $1 and m.subject = $2 and f.special_use = 'drafts'`,
            [accountId, subject],
          )
        )[0].n === 1,
      "the draft synced",
      120_000,
    );
    // «No»: the message and the file uploaded for it are gone.
    await page.getByRole("button", { name: "Redactar" }).click();
    const other = page.locator('[data-ui="mail-compose"]').last();
    await other.getByLabel("Asunto").fill(`Descartado ${stamp}`);
    await other.locator('input[type="file"]').setInputFiles({
      name: "temporal.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("no debe quedar"),
    });
    const chip = other.locator('[data-attachment="temporal.txt"][data-status="ready"]');
    await chip.waitFor();
    const key = await chip.getAttribute("data-key");
    assert.ok(key);
    assert.equal((await s3.fetch(`${S3}/${key}`, { method: "HEAD" })).status, 200);
    tab = page.locator('[data-ui="mail-tab"]').filter({ hasText: `Descartado ${stamp}` });
    await tab.getByRole("button", { name: /^Cerrar/ }).click();
    await ask.getByRole("button", { name: "No" }).click();
    await tab.waitFor({ state: "detached" });
    await until(
      async () => (await s3.fetch(`${S3}/${key}`, { method: "HEAD" })).status === 404,
      "the upload removed",
    );
    assert.equal(await serverDraft(`Descartado ${stamp}`), null);
  });

  test("T62: a meeting from a message invites its people by mail", async () => {
    const view = await openMessage("Informe con adjuntos");
    await view.getByRole("button", { name: "Programar reunión" }).click();
    const form = page.locator('[data-ui="agenda-form"]');
    await form.waitFor();
    assert.equal(await form.getByLabel("Título").inputValue(), "Informe con adjuntos");
    assert.match(
      await form.locator('[data-recipients="Invitados"]').getAttribute("data-value"),
      /ana\.r@otro\.test/,
    );
    await form.getByLabel("Hora de inicio").fill("16:00");
    await form.getByLabel("Hora de fin").fill("16:30");
    await form.getByRole("button", { name: "Guardar" }).click();
    await page.getByText("Reunión programada; se enviaron las invitaciones.").waitFor();
    const { message } = await received("Invitación: Informe con adjuntos");
    const raw = await (await fetch(`${SMTP_API}/api/v1/message/${message.ID}/raw`)).text();
    assert.match(raw, /METHOD:REQUEST/);
    assert.match(raw.replace(/\r?\n /g, ""), /ATTENDEE[^\n]*mailto:ana\.r@otro\.test/i);
    assert.ok((await davEvents()).some((item) => item.includes("SUMMARY:Informe con adjuntos")));
  });

  test("T63: an invitation received by mail is answered from the message and from the Agenda, with its color", async () => {
    const uid = `inv-${stamp}`;
    seed("invite", "ana@prueba.test", "Correo-Ana-2026", uid);
    await syncNow();
    const view = await openMessage("Invitación: Revisión del proyecto");
    const card = view.locator('[data-ui="mail-invitation"]');
    await card.getByText("Revisión del proyecto").first().waitFor({ timeout: 90_000 });
    assert.match(await card.innerText(), /Sala 4/);
    await card.getByRole("button", { name: "Aceptar" }).click();
    await card.getByText(/Respuesta enviada/).waitFor();
    let { message } = await received("Aceptado: Revisión del proyecto");
    assert.deepEqual(
      message.To.map((item) => item.Address),
      ["carlos.mena@prueba.test"],
    );
    let raw = await calendarPart(message);
    assert.match(raw, /METHOD:REPLY/);
    assert.match(raw, /PARTSTAT=ACCEPTED/);
    assert.ok(
      (await davEvents()).some((item) => item.includes(uid) && /PARTSTAT=ACCEPTED/.test(item)),
    );
    // In the Agenda: accepted, then declined from there.
    await page.goto(`${base}/mail`);
    await page.locator('[data-ui="mail-agenda-entry"]').click();
    const agenda = page.locator('[data-ui="mail-agenda"]');
    await agenda.getByRole("button", { name: "Lista" }).click();
    const pill = agenda.locator('[data-event="Revisión del proyecto"]').first();
    await pill.waitFor();
    assert.equal(await pill.getAttribute("data-answer"), "ACCEPTED");
    await pill.click();
    const detail = page.locator('[data-ui="agenda-event"]');
    assert.equal(
      await detail.getByRole("button", { name: "Editar" }).count(),
      0,
      "a guest does not edit",
    );
    await detail.getByRole("button", { name: "Rechazar" }).click();
    await agenda
      .locator('[data-event="Revisión del proyecto"][data-answer="DECLINED"]')
      .first()
      .waitFor();
    ({ message } = await received("Rechazado: Revisión del proyecto"));
    raw = await calendarPart(message);
    assert.match(raw, /PARTSTAT=DECLINED/);
  });

  test("T64: the gear opens a menu; Preferencias keeps the signature", async () => {
    await page.goto(`${base}/mail`);
    await page.getByRole("button", { name: "Opciones del correo" }).click();
    const menu = page.locator('[data-ui="mail-settings-menu"]');
    await menu.getByRole("menuitem", { name: "Cuentas de correo" }).waitFor();
    await menu.getByRole("menuitem", { name: "Preferencias" }).click();
    const prefs = page.locator('[data-ui="mail-preferences"]');
    await prefs.getByLabel("Firma").fill("Ana desde Preferencias");
    await prefs.getByRole("button", { name: "Guardar" }).click();
    await until(
      async () =>
        (await query(`select signature from mail_account where id = $1`, [accountId]))[0]
          .signature === "Ana desde Preferencias",
      "signature from Preferencias",
    );
    assert.match(page.url(), /\/mail\/?(\?|$)/, "stays in the mail screen");
  });

  test("T65: MCP: new mail is detected, drafts are kept, recipients and the Agenda", async () => {
    await query(`update mail_account set mcp_access = true where id = $1`, [accountId]);
    const start = await mcp(ana.token, "wait_for_mail");
    assert.ok(start.data.cursor);
    const subject = `Llega por MCP ${stamp}`;
    seed("one", "ana@prueba.test", "Correo-Ana-2026", subject);
    await query(`update mail_account set next_sync_at = 0 where id = $1`, [accountId]);
    let found = null;
    for (let i = 0; i < 6 && !found; i += 1) {
      const next = await mcp(ana.token, "wait_for_mail", {
        cursor: start.data.cursor,
        wait_seconds: 20,
      });
      found = next.data.messages.find((item) => item.untrusted_content.subject === subject) ?? null;
    }
    assert.ok(found, "detected by wait_for_mail");
    const draft = await mcp(ana.token, "save_mail_draft", {
      to: "destino@otro.test",
      subject: `Borrador MCP ${stamp}`,
      text: "Escrito por el asistente.",
    });
    assert.equal(draft.error, false, JSON.stringify(draft.data));
    assert.ok(await serverDraft(`Borrador MCP ${stamp}`), "in the server's Drafts");
    assert.equal(await smtpCount(`Borrador MCP ${stamp}`), 0, "not sent");
    const people = await mcp(ana.token, "find_recipients", { query: "rodd" });
    assert.ok(people.data.people.some((item) => item.address === "roddy.andrade@prueba.test"));
    const events = await mcp(ana.token, "list_calendar_events");
    assert.ok(events.data.calendars.length >= 1);
    const created = await mcp(ana.token, "create_calendar_event", {
      calendar_id: events.data.calendars[0].id,
      title: `Evento MCP ${stamp}`,
      start: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      end: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
    });
    assert.equal(created.error, false, JSON.stringify(created.data));
    assert.ok((await davEvents()).some((item) => item.includes(`Evento MCP ${stamp}`)));
  });

  test("the Carpeta Personal folds and unfolds, remembered, without changing what a click on it does", async () => {
    await page.goto(`${base}/`);
    const fold = page.locator('[data-ui="personal-fold"]');
    await fold.waitFor();
    const portfolio = page.getByText("Adjuntos guardados", { exact: true }).first();
    await portfolio.waitFor();
    await fold.click();
    await portfolio.waitFor({ state: "detached" });
    assert.equal(await fold.getAttribute("aria-expanded"), "false");
    await page.reload();
    await fold.waitFor();
    assert.equal(await fold.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByText("Adjuntos guardados", { exact: true }).count(), 0);
    await fold.click();
    await page.getByText("Adjuntos guardados", { exact: true }).first().waitFor();
  });
  test("over plain http by a name (an insecure origin, as by IP): Redactar, replies, the right click and tabs work", async () => {
    // Chrome treats http://grafito.test as insecure (no crypto.randomUUID), unlike 127.0.0.1.
    const insecure = await playwright.chromium.launch({
      channel: process.env.E2E_CHANNEL ?? "chrome",
      args: [`--host-resolver-rules=MAP grafito.test 127.0.0.1`],
    });
    const origin = base.replace("127.0.0.1", "grafito.test");
    const context = await insecure.newContext({ viewport: { width: 1500, height: 950 } });
    const own = await context.newPage();
    own.on("dialog", (dialog) => void dialog.accept());
    const errors = [];
    own.on("pageerror", (error) => errors.push(error.message));
    own.setDefaultTimeout(30_000);
    try {
      await own.goto(`${origin}/login`);
      assert.equal(await own.evaluate(() => window.isSecureContext), false);
      const token = await own.evaluate(
        async ({ email, password }) =>
          (
            await fetch("/api/auth/sign-in/email", {
              method: "POST",
              credentials: "omit",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email, password }),
            })
          ).headers.get("set-auth-token"),
        { email: `${ana.login}@grafito.app`, password: PASSWORD },
      );
      assert.ok(token, "signed in on the insecure origin");
      await context.addInitScript((value) => {
        // Also runs in the sandboxed mail frame, where storage is off.
        try {
          localStorage.setItem("grafito-auth.bearer-token", value);
        } catch {
          /* not this frame */
        }
      }, token);
      await own.goto(`${origin}/mail`);
      const rows = own.locator('[data-ui="mail-list"] [data-message]');
      await rows.first().waitFor();
      // Redactar.
      await own.getByRole("button", { name: "Redactar" }).click();
      const compose = own.locator('[data-ui="mail-compose"]').last();
      await compose.waitFor();
      await compose.locator('input[type="file"]').setInputFiles({
        name: "inseguro.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("x"),
      });
      await compose.locator('[data-attachment="inseguro.txt"][data-status="ready"]').waitFor();
      // Responder and Reenviar from the message.
      await rows.filter({ hasText: "Informe con adjuntos" }).first().click();
      const view = own
        .locator('[data-ui="mail-message"]')
        .filter({ hasText: "Informe con adjuntos" })
        .first();
      await view.getByRole("button", { name: "Responder", exact: true }).click();
      await own
        .locator('[data-ui="mail-tab"][data-compose]')
        .filter({ hasText: "Re: Informe con adjuntos" })
        .waitFor();
      await rows.filter({ hasText: "Informe con adjuntos" }).first().click();
      await view.getByRole("button", { name: "Reenviar" }).click();
      await own
        .locator('[data-ui="mail-tab"][data-compose]')
        .filter({ hasText: "Rv: Informe con adjuntos" })
        .waitFor();
      // The right click: Abrir en una nueva pestaña, Responder a todos.
      const menu = own.locator('[data-ui="mail-row-menu"]');
      await rows.filter({ hasText: "HTML peligroso" }).first().click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Abrir en una nueva pestaña" }).click();
      await own.locator('[data-ui="mail-tab"]').filter({ hasText: "HTML peligroso" }).waitFor();
      await rows.filter({ hasText: "Informe con adjuntos" }).first().click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Responder a todos" }).click();
      await own
        .locator('[data-ui="mail-tab"][data-compose]')
        .filter({ hasText: "Re: Informe con adjuntos" })
        .nth(1)
        .waitFor();
      assert.deepEqual(errors, [], "no script errors");
    } finally {
      await insecure.close();
    }
  });
  test("English routes: old ones redirect; the mailbox and the Agenda survive a reload", async () => {
    await page.goto(`${base}/correo`);
    await page.waitForURL(/\/mail\/?(\?|$)/);
    await page.goto(`${base}/cuenta?seccion=buzones`);
    await page.waitForURL(/\/account\?section=mailboxes$/);
    await page.locator('[data-ui="mail-accounts"]').waitFor();
    // A mailbox: in the address, kept on reload.
    await page.goto(`${base}/mail`);
    await page.getByRole("button", { name: "Enviados" }).click();
    await page.waitForURL(/[?&]box=sent/);
    await page.reload();
    assert.equal(
      await page.getByRole("button", { name: "Enviados" }).getAttribute("aria-current"),
      "page",
    );
    // The Agenda and its view.
    await page.locator('[data-ui="mail-agenda-entry"]').click();
    await page.waitForURL(/\/mail\/calendar/);
    await page.locator('[data-ui="mail-agenda"]').getByRole("button", { name: "Semana" }).click();
    await page.waitForURL(/view=week/);
    await page.reload();
    await page.locator('[data-ui="mail-agenda"] [data-mode="week"]').waitFor();
  });

  test("CC and CCO fold again; the options menu stays inside the window; rows line up; notices fade", async () => {
    await page.goto(`${base}/mail`);
    // Rows: the flag, clip and date always end at the same place.
    await page.locator('[data-ui="mail-list"] [data-message]').first().waitFor();
    const rights = await page
      .locator('[data-ui="mail-row-meta"]')
      .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().right)));
    assert.ok(rights.length > 2);
    assert.equal(new Set(rights).size, 1, `aligned: ${rights.join(",")}`);
    // The gear's menu, clear of the window's edges.
    await page.getByRole("button", { name: "Opciones del correo" }).click();
    const box = await page.locator('[data-ui="mail-settings-menu"]').boundingBox();
    const width = page.viewportSize().width;
    assert.ok(box.x >= 8 && box.x + box.width <= width - 8, JSON.stringify(box));
    await page.keyboard.press("Escape");
    await page.mouse.click(width - 20, 400);
    // CC and CCO open and close.
    const form = await compose();
    const copies = form.getByRole("button", { name: "CC y CCO" });
    await copies.click();
    await form.getByLabel("CC", { exact: true }).waitFor();
    await copies.click();
    await form.getByLabel("CC", { exact: true }).waitFor({ state: "detached" });
    // A notice floats and fades.
    await form.getByLabel("Para").fill("destino@otro.test");
    await form.getByLabel("Asunto").fill(`Aviso ${stamp}`);
    await form.getByRole("button", { name: "Enviar", exact: true }).click();
    const notice = page.locator('[data-ui="toast"]').filter({ hasText: "Mensaje enviado." });
    await notice.waitFor();
    await notice.waitFor({ state: "detached", timeout: 8000 });
  });
  test("the whole message scrolls; its header folds into a compact bar; Enviar and Descartar stay on top", async () => {
    await page.setViewportSize({ width: 1400, height: 560 });
    try {
      const view = await openMessage("HTML peligroso con imagen embebida");
      // One scroller: the body frame takes its content's height, nothing scrolls inside it.
      const frame = view.locator('[data-ui="mail-body"]');
      await frame.waitFor();
      await page.waitForTimeout(500);
      const sizes = await frame.evaluate((element) => ({
        frame: element.getBoundingClientRect().height,
        content: element.contentDocument?.documentElement.scrollHeight ?? 0,
      }));
      assert.ok(Math.abs(sizes.frame - sizes.content) <= 4, JSON.stringify(sizes));
      const bar = view.locator('[data-ui="mail-compact-bar"]');
      assert.equal(await bar.getAttribute("aria-hidden"), "true");
      await view.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await page.waitForFunction(
        () =>
          document.querySelector('[data-ui="mail-compact-bar"]')?.getAttribute("aria-hidden") ===
          "false",
      );
      await bar.getByRole("button", { name: "Responder", exact: true }).click();
      const pane = page.locator('[data-ui="mail-compose-pane"]').last();
      await pane.waitFor();
      // Writing: the bar with Enviar and Descartar stays at the top while the rest scrolls.
      await pane.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      const [top, barTop] = await Promise.all([
        pane.evaluate((element) => element.getBoundingClientRect().top),
        pane
          .locator('[data-ui="mail-compose-bar"]')
          .evaluate((element) => element.getBoundingClientRect().top),
      ]);
      assert.ok(Math.abs(top - barTop) <= 1, `${top} vs ${barTop}`);
      await pane
        .locator('[data-ui="mail-compose-bar"]')
        .getByRole("button", { name: "Enviar", exact: true })
        .waitFor();
    } finally {
      await page.setViewportSize({ width: 1500, height: 950 });
    }
  });

  /** The flags a message has on the IMAP server itself. */
  async function serverFlags(subject, folder = "INBOX") {
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: Number(process.env.MAIL_TEST_PORT || 1993),
      secure: true,
      servername: "imap-test",
      tls: { ca: [readFileSync(new URL("../../.data/imap-test/certs/ca.crt", import.meta.url))] },
      auth: { user: "ana@prueba.test", pass: "Correo-Ana-2026" },
      logger: false,
    });
    await client.connect();
    try {
      await client.mailboxOpen(folder);
      const uids = await client.search({ subject }, { uid: true });
      if (!uids?.length) return null;
      const message = await client.fetchOne(String(uids.at(-1)), { flags: true }, { uid: true });
      return [...message.flags];
    } finally {
      await client.logout();
    }
  }

  test("spam and trash sync like the other folders", async () => {
    seed("into", "ana@prueba.test", "Correo-Ana-2026", `Junk|En spam ${stamp}`);
    seed("into", "ana@prueba.test", "Correo-Ana-2026", `Trash|En la papelera ${stamp}`);
    await syncNow();
    await until(
      async () =>
        (
          await query(
            `select count(*)::int n from mail_message where account_id = $1 and subject in ($2, $3)`,
            [accountId, `En spam ${stamp}`, `En la papelera ${stamp}`],
          )
        )[0].n === 2,
      "spam and trash synced",
      120_000,
    );
    await page.goto(`${base}/mail?box=junk`);
    await page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: `En spam ${stamp}` })
      .waitFor();
    await page.goto(`${base}/mail?box=trash`);
    await page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: `En la papelera ${stamp}` })
      .waitFor();
  });

  test("read and flagged go both ways with the mail server", async () => {
    const subject = `Banderas ${stamp}`;
    seed("one", "ana@prueba.test", "Correo-Ana-2026", subject);
    await syncNow();
    await until(
      async () =>
        (
          await query(
            `select count(*)::int n from mail_message where account_id = $1 and subject = $2`,
            [accountId, subject],
          )
        )[0].n === 1,
      "the message synced",
    );
    // Opened and flagged in Grafito: the server gets \Seen and \Flagged.
    await openMessage(subject);
    const row = page
      .locator('[data-ui="mail-list"] [data-message]')
      .filter({ hasText: subject })
      .first();
    await row.locator('[data-ui="mail-flag"]').click();
    await until(async () => {
      const flags = await serverFlags(subject);
      return Boolean(flags?.includes("\\Seen") && flags.includes("\\Flagged"));
    }, "read and flagged on the server");
    // Marked unread in Grafito: the server loses \Seen.
    await row.click({ button: "right" });
    await page
      .locator('[data-ui="mail-row-menu"]')
      .getByRole("menuitem", { name: "Marcar como no leído" })
      .click();
    await until(
      async () => !(await serverFlags(subject))?.includes("\\Seen"),
      "unread on the server",
    );
    // Read in another client (the server): Grafito follows after a sync.
    seed("flag", "ana@prueba.test", "Correo-Ana-2026", subject);
    await syncNow();
    await until(
      async () =>
        (
          await query(
            `select coalesce(local_seen, remote_seen) as seen from mail_message where account_id = $1 and subject = $2`,
            [accountId, subject],
          )
        )[0].seen === true,
      "read in Grafito after reading elsewhere",
    );
  });

  test("Cuentas de correo scrolls, folds its cards, has no signature, offers Gmail; De shows the name", async () => {
    await page.setViewportSize({ width: 1400, height: 420 });
    try {
      await page.goto(`${base}/account?section=mailboxes`);
      const content = page.locator('[data-ui="account-content"]');
      await page
        .locator('[data-ui="mail-account"]')
        .first()
        .getByLabel("Nombre de la cuenta")
        .waitFor();
      const scroll = await content.evaluate((element) => ({
        overflow: getComputedStyle(element).overflowY,
        more: element.scrollHeight > element.clientHeight,
      }));
      assert.deepEqual(scroll, { overflow: "auto", more: true });
      await content.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      assert.ok((await content.evaluate((element) => element.scrollTop)) > 0, "it scrolls");
      assert.equal(
        await page.locator('[data-ui="mail-signature"]').count(),
        0,
        "no signature here",
      );
      const card = page.locator('[data-ui="mail-account"]').first();
      const fold = card.locator('[data-ui="mail-account-fold"]');
      await fold.click();
      await card.getByLabel("Nombre de la cuenta").waitFor({ state: "detached" });
      await fold.click();
      await card.getByLabel("Nombre de la cuenta").waitFor();
      await page.getByRole("button", { name: "Añadir otra cuenta" }).click();
      const add = page.locator('[data-ui="mail-add"]');
      await add.getByLabel("Proveedor").selectOption({ label: "Gmail" });
      assert.equal(await add.getByLabel("Servidor IMAP").inputValue(), "imap.gmail.com");
      assert.equal(await add.getByLabel("Servidor SMTP (envío)").inputValue(), "smtp.gmail.com");
    } finally {
      await page.setViewportSize({ width: 1500, height: 950 });
    }
    // De: the person's name, the address on a double click.
    const form = await compose();
    const from = form.getByLabel("De", { exact: true });
    const shown = await from.evaluate((element) => element.selectedOptions[0]?.textContent ?? "");
    assert.ok(shown && !shown.includes("@"), shown);
    await from.locator("xpath=..").dblclick({ position: { x: 4, y: 4 } });
    await form.locator('[data-ui="from-address"]').getByText("ana@prueba.test").waitFor();
  });
  test("several messages are ticked without selecting text and deleted on the server; from the trash for good", async () => {
    const subjects = ["A", "B", "C"].map((letter) => `Para borrar ${letter} ${stamp}`);
    for (const subject of subjects) seed("one", "ana@prueba.test", "Correo-Ana-2026", subject);
    await syncNow();
    await until(
      async () =>
        (
          await query(
            `select count(*)::int n from mail_message where account_id = $1 and subject like $2`,
            [accountId, `Para borrar % ${stamp}`],
          )
        )[0].n === 3,
      "three messages synced",
    );
    await page.goto(`${base}/mail`);
    const row = (subject) =>
      page.locator('[data-ui="mail-list"] [data-message]').filter({ hasText: subject }).first();
    // Only these three in the list, in whatever order they share the same minute.
    await page.getByPlaceholder("Buscar en el correo").fill(`Para borrar ${stamp}`);
    const listed = page.locator('[data-ui="mail-list"] [data-message]');
    await until(async () => (await listed.count()) === 3, "the three in the list");
    const order = await listed.evaluateAll((items) => items.map((item) => item.textContent ?? ""));
    const ranked = order.map((text) => subjects.find((subject) => text.includes(subject)));
    subjects.splice(0, 3, ...ranked);
    // The open message: an accent bar inside the row, no outline the list would cut.
    await row(subjects[0]).click();
    const look = await row(subjects[0]).evaluate((element) => ({
      shadow: getComputedStyle(element).boxShadow,
      radius: getComputedStyle(element).borderRadius,
    }));
    assert.match(look.shadow, /inset/);
    // Shift and a click ticks the run from the open one; Ctrl and a click ticks one on or off.
    await row(subjects[2]).click({ modifiers: ["Shift"] });
    const bulk = page.locator('[data-ui="mail-bulk"]');
    await bulk.getByText("3 seleccionados").waitFor();
    await row(subjects[1]).click({ modifiers: ["Control"] });
    await bulk.getByText("2 seleccionados").waitFor();
    await row(subjects[1]).click({ modifiers: ["Control"] });
    await bulk.getByText("3 seleccionados").waitFor();
    assert.equal(await page.evaluate(() => String(window.getSelection())), "", "no text selected");
    assert.equal(await page.locator('[data-ui="mail-list"] [data-checked]').count(), 3);
    await bulk.getByRole("button", { name: "Eliminar" }).click();
    await page.getByText("3 mensajes movidos a la papelera.").waitFor();
    for (const subject of subjects) assert.equal(await row(subject).count(), 0);
    await until(async () => {
      for (const subject of subjects) {
        if ((await serverFlags(subject, "INBOX")) !== null) return false;
        if ((await serverFlags(subject, "Trash")) === null) return false;
      }
      return true;
    }, "moved to the server's trash");
    // From the trash: the box on each row, then a confirmation, then gone from the server.
    await syncNow();
    await page.goto(`${base}/mail?box=trash`);
    for (const subject of subjects) {
      await row(subject).waitFor({ timeout: 120_000 });
      await row(subject).locator('[data-ui="mail-check"]').check();
    }
    await bulk.getByText("3 seleccionados").waitFor();
    await bulk.getByRole("button", { name: "Eliminar" }).click();
    await bulk.getByText("¿Eliminar definitivamente 3?").waitFor();
    await bulk.getByRole("button", { name: "Eliminar" }).click();
    await page.getByText("3 mensajes eliminados definitivamente.").waitFor();
    await until(async () => {
      for (const subject of subjects)
        if ((await serverFlags(subject, "Trash")) !== null) return false;
      return true;
    }, "deleted for good on the server");
  });

  test("a meeting being scheduled closes with a click outside or Escape", async () => {
    await page.goto(`${base}/mail`);
    const first = page.locator('[data-ui="mail-list"] [data-message]').first();
    for (const close of ["outside", "Escape"]) {
      await first.click({ button: "right" });
      await page
        .locator('[data-ui="mail-row-menu"]')
        .getByRole("menuitem", { name: "Programar reunión" })
        .click();
      const dialog = page.locator('[data-ui="dialog"]');
      await dialog.getByText("Programar reunión").waitFor();
      if (close === "outside") await page.mouse.click(8, 8);
      else await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
    }
  });
});
