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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

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

async function smtpCount(subject) {
  const list = await (
    await fetch(`${SMTP_API}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)
  ).json();
  return list.messages?.length ?? 0;
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
    await page.waitForURL(/\/correo$/);
    await page.locator('[data-ui="mail"][data-empty]').waitFor();
    assert.equal(await page.locator('[data-ui="mail-add"]').count(), 0);
    assert.equal(await page.locator('[data-ui="mail-list"]').count(), 0);
    // No administration of mail accounts any more.
    assert.equal(
      (await query(`select count(*)::int n from app_permission where key = 'mailbox.manage'`))[0].n,
      0,
    );
    await page.goto(`${base}/cuenta`);
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
    await page.goto(`${base}/cuenta?seccion=buzones`);
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
    await page.goto(`${base}/correo`);
    await page.locator('[data-ui="mail-list"] [data-message]').first().waitFor();
    const subjects = await page.locator('[data-ui="mail-list"] [data-message]').allInnerTexts();
    assert.ok(subjects.some((text) => text.includes("Informe con adjuntos")));
    assert.ok(
      !subjects.some((text) => text.includes("Muy antiguo fuera de la ventana")),
      "outside the 30-day window",
    );
    // Credentials never come back, and they are stored sealed.
    const row = (await query(`select secret from mail_account where id = $1`, [accountId]))[0];
    assert.doesNotMatch(row.secret, /Correo-Ana-2026/);
  });

  async function openMessage(subject) {
    await page.goto(`${base}/correo`);
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
      "allow-popups allow-popups-to-escape-sandbox",
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
    await view.getByText(/Guardado en Grafito/).waitFor();
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
    await view.getByText(/El \.eml se está guardando/).waitFor();
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
    await page.goto(`${base}/correo`);
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
    await other.goto(`${base}/correo`);
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
    await page.goto(`${base}/cuenta?seccion=buzones`);
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
    await page.goto(`${base}/cuenta?seccion=buzones`);
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
    await page.goto(`${base}/correo`);
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
    assert.equal(await form.getByLabel("Para").inputValue(), "ana.r@otro.test");
    assert.equal(await form.getByLabel("Asunto").inputValue(), "Re: Informe con adjuntos");
    assert.match(await form.getByLabel("Mensaje").inputValue(), /> Te adjunto el informe/);
    await form.getByRole("button", { name: "CC y CCO" }).click();
    await form.getByLabel("CCO").fill("oculto@otro.test");
    await form.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByText("Mensaje enviado.").waitFor();
    const { message, headers } = await received("Re: Informe con adjuntos");
    assert.equal(headers["In-Reply-To"]?.[0], original);
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
});
