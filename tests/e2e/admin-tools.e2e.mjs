/**
 * Administration tools in real browser engines against the local test stack (project
 * grafito-e2e): the user modal (LDAP accounts keep name and email), system log filters, and
 * extensions blocked from upload or from indexing. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_BROWSERS=chromium,firefox \
 *   node --test tests/e2e/admin-tools.e2e.mjs
 *
 * It writes only rows whose ids, logins or messages start with "e2eadm" and restores the
 * extension settings it changes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const engines = (process.env.E2E_BROWSERS ?? "chromium,firefox").split(",");
const PASSWORD = process.env.E2E_PASSWORD ?? "Prueba-Admin-2026";
const ADMIN = "e2eadm-admin";
const WAIT = 60_000;
const RULE_KEYS = ["upload_blocked_ext", "index_blocked_ext"];

function database() {
  return new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:15432/grafito",
  });
}

async function account(client, login, { name = login, role = "miembro", source = "local" } = {}) {
  const email = `${login}@grafito.app`;
  const known = await client.query(`select id from "user" where email = $1`, [email]);
  let id = known.rows[0] ? String(known.rows[0].id) : "";
  if (!id) {
    id = `e2eadm-${randomUUID()}`;
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, false, now(), now())`,
      [id, name, email],
    );
    await client.query(
      `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), id, await hashPassword(PASSWORD)],
    );
  }
  await client.query(`update "user" set name = $2 where id = $1`, [id, name]);
  await client.query(
    `insert into app_user_role (user_id, role_id, login_name, source) values ($1, $2, $3, $4)
     on conflict (user_id) do update set role_id = excluded.role_id, source = excluded.source`,
    [id, role, login, source],
  );
  return id;
}

let saved = [];
let ids = {};

async function seed() {
  const client = database();
  await client.connect();
  try {
    ids.admin = await account(client, ADMIN, { role: "admin" });
    // A list long enough that a form under it would be off screen.
    for (let n = 1; n <= 30; n += 1) await account(client, `e2eadm-u${String(n).padStart(2, "0")}`);
    ids.local = await account(client, "e2eadm-zlocal", { name: "e2eadm Zeta Local" });
    ids.ldap = await account(client, "e2eadm-zldap", { name: "e2eadm Zeta Ldap", source: "ldap" });
    await client.query(`delete from app_log where id like 'e2eadm-%'`);
    await client.query(
      `insert into app_log (id, at, actor, area, message) values
         ('e2eadm-1', '2026-01-10T10:00:00Z', 'e2eadm-ana', 'Usuarios', 'e2eadm alfa'),
         ('e2eadm-2', '2026-03-10T10:00:00Z', 'e2eadm-beto', 'Seguridad', 'e2eadm beta'),
         ('e2eadm-3', '2026-03-10T12:00:00Z', 'e2eadm-ana', 'Seguridad', 'e2eadm gamma')`,
    );
    const rules = await client.query(`select key, value from app_setting where key = any($1)`, [
      RULE_KEYS,
    ]);
    saved = rules.rows;
  } finally {
    await client.end();
  }
}

async function cleanup() {
  const client = database();
  await client.connect();
  try {
    await client.query(`delete from app_setting where key = any($1)`, [RULE_KEYS]);
    for (const row of saved)
      await client.query(`insert into app_setting (key, value) values ($1, $2)`, [
        row.key,
        row.value,
      ]);
    await client.query(`delete from app_log where id like 'e2eadm-%'`);
    await client.query(`delete from vault_doc where id like 'e2eadm-%' or user_id = $1`, [
      ids.admin ?? "",
    ]);
  } finally {
    await client.end();
  }
}

/** Bearer token per engine: sign-in is rate limited, so each engine signs in once. */
let token = "";

async function signIn(browser, login, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  if (!token) {
    await page.goto(`${base}/login`);
    const result = await page.evaluate(
      async ({ email, password }) => {
        const response = await fetch("/api/auth/sign-in/email", {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        return { status: response.status, token: response.headers.get("set-auth-token") ?? "" };
      },
      { email: `${login}@grafito.app`, password: PASSWORD },
    );
    assert.equal(result.status, 200, `sign-in ${login}`);
    token = result.token;
  }
  await context.addInitScript((value) => {
    localStorage.setItem("grafito-auth.bearer-token", value);
  }, token);
  return { context, page };
}

async function openAdmin(page, section, leaf) {
  await page.goto(`${base}/admin`);
  await page.getByRole("button", { name: section }).first().click();
  if (leaf) await page.getByRole("button", { name: leaf, exact: true }).first().click();
}

/** Visible log messages seeded by this test. */
async function seededLogs(page) {
  await page.waitForFunction(() => !document.querySelector("form button[disabled]"));
  const texts = await page.locator("li p.text-sm").allTextContents();
  return texts.filter((text) => text.startsWith("e2eadm ")).sort();
}

for (const engine of engines) {
  describe(`admin tools (${engine})`, () => {
    let browser;
    before(async () => {
      token = "";
      await seed();
      browser =
        engine === "chrome"
          ? await playwright.chromium.launch({ channel: "chrome" })
          : await playwright[engine].launch();
    });
    after(async () => {
      await browser?.close();
      await cleanup();
    });

    test("users open in a modal; LDAP keeps name and email", async () => {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 780 },
      ]) {
        const { context, page } = await signIn(browser, ADMIN, { viewport });
        await openAdmin(page, "Usuarios y permisos", "Usuarios");
        await page.getByRole("button", { name: /e2eadm Zeta Ldap/ }).click();
        const dialog = page.getByRole("dialog", { name: "Actualizar usuario" });
        await dialog.waitFor();
        const box = await dialog.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height + 1, "in view");
        assert.equal(await dialog.getByText("LDAP", { exact: true }).count(), 1);
        const name = dialog.getByLabel("Nombre");
        const email = dialog.getByLabel("Correo");
        assert.equal(await name.getAttribute("readonly"), "");
        assert.equal(await email.getAttribute("readonly"), "");
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        await dialog.waitFor({ state: "detached" });

        await page.getByRole("button", { name: /e2eadm Zeta Local/ }).click();
        await dialog.waitFor();
        assert.equal(await dialog.getByLabel("Nombre").getAttribute("readonly"), null);
        await context.close();
      }
      const { context, page } = await signIn(browser, ADMIN);
      await openAdmin(page, "Usuarios y permisos", "Usuarios");
      await page.getByRole("button", { name: /e2eadm Zeta Local/ }).click();
      const dialog = page.getByRole("dialog", { name: "Actualizar usuario" });
      await dialog.getByLabel("Nombre").fill("e2eadm Zeta Renombrada");
      await dialog.getByRole("button", { name: "Guardar" }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("button", { name: /e2eadm Zeta Renombrada/ }).waitFor();
      // Restore the name for the next engine.
      await page.getByRole("button", { name: /e2eadm Zeta Renombrada/ }).click();
      await dialog.getByLabel("Nombre").fill("e2eadm Zeta Local");
      await dialog.getByRole("button", { name: "Guardar" }).click();
      await dialog.waitFor({ state: "detached" });
      await context.close();
    });

    test("system logs filter by user, description and date", async () => {
      const { context, page } = await signIn(browser, ADMIN, { timezoneId: "UTC" });
      await openAdmin(page, "Monitorización y logs", "Logs de sistema");
      const form = page.locator("form").first();
      const filter = async (values) => {
        await form.getByLabel("Usuario").fill(values.actor ?? "");
        await form.getByLabel("Descripción").fill(values.text ?? "");
        await form.getByLabel("Desde").fill(values.from ?? "");
        await form.getByLabel("Hasta").fill(values.to ?? "");
        await form.getByRole("button", { name: "Filtrar" }).click();
        return seededLogs(page);
      };
      assert.deepEqual(await filter({ text: "e2eadm" }), [
        "e2eadm alfa",
        "e2eadm beta",
        "e2eadm gamma",
      ]);
      assert.deepEqual(await filter({ actor: "e2eadm-ana" }), ["e2eadm alfa", "e2eadm gamma"]);
      assert.deepEqual(await filter({ text: "beta" }), ["e2eadm beta"]);
      assert.deepEqual(await filter({ text: "e2eadm", from: "2026-03-10T11:00" }), [
        "e2eadm gamma",
      ]);
      assert.deepEqual(
        await filter({ text: "e2eadm", from: "2026-01-01T00:00", to: "2026-03-10T11:00" }),
        ["e2eadm alfa", "e2eadm beta"],
      );
      assert.deepEqual(await filter({ actor: "nadie-e2eadm" }), []);
      await page.getByText("Ningún registro coincide.").waitFor();
      await context.close();
    });

    test("extensions blocked from upload and from indexing", async () => {
      const { context, page } = await signIn(browser, ADMIN);
      await openAdmin(page, "Seguridad");
      const upload = page.locator('[data-extensions="upload"]');
      const index = page.locator('[data-extensions="index"]');
      await upload.getByLabel(".rar", { exact: true }).check();
      await upload.getByLabel(".iso", { exact: true }).check();
      await upload.getByLabel("Otras extensiones").fill(".TORRENT");
      await index.getByLabel(".mp4", { exact: true }).check();
      await page.getByRole("button", { name: "Guardar" }).last().click();
      await page.getByText("Guardado.").last().waitFor();

      const start = (name) =>
        page.evaluate(async (fileName) => {
          const token = localStorage.getItem("grafito-auth.bearer-token") ?? "";
          const response = await fetch("/api/files/uploads", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: fileName, mime: "application/octet-stream", size: 4 }),
          });
          const body = await response.json().catch(() => ({}));
          if (response.ok)
            await fetch("/api/files/uploads/complete", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body: JSON.stringify({ key: body.key, uploadId: body.uploadId, abort: true }),
            });
          return { status: response.status, body };
        }, name);
      const rar = await start("copia.RAR");
      assert.equal(rar.status, 415);
      assert.match(JSON.stringify(rar.body), /No se permite subir archivos \.rar/);
      assert.equal((await start("lista.torrent")).status, 415);
      assert.equal((await start("video.mp4")).status, 200);

      // The browser skips blocked files, uploads the rest and names what it skipped.
      await page.goto(`${base}/`);
      const input = page.locator('input[type="file"][multiple]').first();
      await input.waitFor({ state: "attached" });
      await input.setInputFiles([
        {
          name: "e2eadm-bloqueado.rar",
          mimeType: "application/x-rar",
          buffer: Buffer.from("rar!"),
        },
        { name: "e2eadm-permitido.txt", mimeType: "text/plain", buffer: Buffer.from("hola") },
      ]);
      const summary = page.locator('[data-ui="upload-summary"]').first();
      await page.locator('article[data-job="done"]').waitFor();
      assert.match((await summary.textContent()) ?? "", /Archivos subidos\s*1/);
      assert.match((await summary.textContent()) ?? "", /Omitidos por su extensión\s*1/);
      await summary.getByText("Ver detalle").click();
      await summary
        .getByText(/No se permite subir archivos \.rar \(«e2eadm-bloqueado\.rar»\)/)
        .waitFor();
      await page.getByText("e2eadm-permitido", { exact: true }).first().waitFor();
      assert.equal(await page.getByText("e2eadm-bloqueado", { exact: true }).count(), 0);

      // Stored documents follow the index rule: a .mp4 file stays out of search, a note does not.
      // updated_at 0 puts them first in the reindex queue the save just started.
      const client = database();
      await client.connect();
      try {
        await client.query(
          `insert into vault_doc (user_id, id, title, kind, content, file_name, file_mime, file_key,
             file_size, created_at, updated_at, created_by, updated_by, rev)
           values ($1, 'e2eadm-video', 'e2eadm video', 'file', '', 'e2eadm.mp4', 'video/mp4',
             null, 0, 0, 0, $1, $1, 1),
                  ($1, 'e2eadm-texto', 'e2eadm texto', 'markdown', 'e2eadm texto', null, null,
             null, null, 0, 0, $1, $1, 1)
           on conflict do nothing`,
          [ids.admin],
        );
        const deadline = Date.now() + WAIT;
        let rows = [];
        while (Date.now() < deadline) {
          rows = (
            await client.query(
              `select c.doc_id, c.chars, (d.doc_id is not null) as listed
               from content_index c left join doc_index d
                 on d.user_id = c.user_id and d.doc_id = c.doc_id
               where c.doc_id like 'e2eadm-%' order by c.doc_id`,
            )
          ).rows;
          if (rows.length === 2) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        assert.deepEqual(
          rows.map((row) => [row.doc_id, row.listed]),
          [
            ["e2eadm-texto", true],
            ["e2eadm-video", false],
          ],
        );
      } finally {
        await client.end();
      }
      await context.close();
    });
  });
}
