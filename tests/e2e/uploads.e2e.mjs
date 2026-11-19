/**
 * Background uploads in real browser engines against the local test stack (project
 * grafito-e2e): a dropped folder with empty folders, pause, resume and cancel, the view staying
 * where it was, the antivirus summary, and the folder and file counts. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:8080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_BROWSERS=chromium,firefox \
 *   node --test tests/e2e/uploads.e2e.mjs
 *
 * It writes only the "e2eup-" account and its vault, which each engine resets.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const engines = (process.env.E2E_BROWSERS ?? "chromium,firefox").split(",");
const PASSWORD = process.env.E2E_PASSWORD ?? "Prueba-Carga-2026";
const LOGIN = "e2eup-user";
const WAIT = 120_000;
/** The EICAR test string, which every antivirus reports; kept encoded so no tool flags it. */
const EICAR_B64 =
  "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=";

function database() {
  return new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:5432/grafito",
  });
}

let userId = "";
let ownerId = "";

/** A member with an empty vault holding one portfolio and one note. */
async function seed() {
  const client = database();
  await client.connect();
  try {
    const email = `${LOGIN}@grafito.app`;
    const known = await client.query(`select id from "user" where email = $1`, [email]);
    userId = known.rows[0] ? String(known.rows[0].id) : `e2eup-${randomUUID()}`;
    if (!known.rows[0]) {
      await client.query(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, $2, $3, false, now(), now())`,
        [userId, LOGIN, email],
      );
      await client.query(
        `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         values ($1, $2, 'credential', $2, $3, now(), now())`,
        [randomUUID(), userId, await hashPassword(PASSWORD)],
      );
    }
    await client.query(
      `insert into app_user_role (user_id, role_id, login_name) values ($1, 'miembro', $2)
       on conflict (user_id) do update set role_id = 'miembro'`,
      [userId, LOGIN],
    );
    await client.query(`delete from vault_doc where user_id = $1`, [userId]);
    await client.query(`delete from vault_portfolio where user_id = $1`, [userId]);
    const state = await client.query(
      `insert into vault_state (user_id, revision) values ($1, 1)
       on conflict (user_id) do update set revision = vault_state.revision + 1
       returning revision`,
      [userId],
    );
    const rev = Number(state.rows[0].revision);
    const now = Date.now();
    await client.query(
      `insert into vault_portfolio (user_id, id, name, parent_id, rev) values ($1, 'e2eup-dest', 'e2eup Destino', null, $2)`,
      [userId, rev],
    );
    await client.query(
      `insert into vault_doc (user_id, id, title, kind, content, created_at, updated_at, created_by, updated_by, rev)
       values ($1, 'e2eup-nota', 'e2eup Nota', 'markdown', 'Nota abierta durante la carga', $2, $2, $1, $1, $3)`,
      [userId, now, rev],
    );
    // A second person shares a portfolio with edit access.
    const ownerEmail = "e2eup-owner@grafito.app";
    const owner = await client.query(`select id from "user" where email = $1`, [ownerEmail]);
    ownerId = owner.rows[0] ? String(owner.rows[0].id) : `e2eup-${randomUUID()}`;
    if (!owner.rows[0])
      await client.query(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, 'e2eup-owner', $2, false, now(), now())`,
        [ownerId, ownerEmail],
      );
    await client.query(
      `insert into app_user_role (user_id, role_id, login_name) values ($1, 'miembro', 'e2eup-owner')
       on conflict (user_id) do nothing`,
      [ownerId],
    );
    await client.query(`delete from share_grant where share_id = 'e2eup-share'`);
    await client.query(`delete from share_item where id = 'e2eup-share'`);
    await client.query(`delete from vault_doc where user_id = $1`, [ownerId]);
    await client.query(`delete from vault_portfolio where user_id = $1`, [ownerId]);
    const ownerState = await client.query(
      `insert into vault_state (user_id, revision) values ($1, 1)
       on conflict (user_id) do update set revision = vault_state.revision + 1
       returning revision`,
      [ownerId],
    );
    await client.query(
      `insert into vault_portfolio (user_id, id, name, parent_id, rev)
       values ($1, 'e2eup-shared', 'e2eup Compartido', null, $2)`,
      [ownerId, Number(ownerState.rows[0].revision)],
    );
    await client.query(
      `insert into share_item (id, owner_id, kind, target_id, title, visibility, access)
       values ('e2eup-share', $1, 'portfolio', 'e2eup-shared', 'e2eup Compartido', 'shared', 'edit')`,
      [ownerId],
    );
    await client.query(
      `insert into share_grant (share_id, user_id, granted_at) values ('e2eup-share', $1, $2)`,
      [userId, now],
    );
  } finally {
    await client.end();
  }
}

/** Folders and files the owner of the shared portfolio now holds. */
async function ownerCounts() {
  const client = database();
  await client.connect();
  try {
    const folders = await client.query(
      `select name from vault_portfolio where user_id = $1 and not deleted order by name`,
      [ownerId],
    );
    const files = await client.query(
      `select count(*)::int as n from vault_doc where user_id = $1 and not deleted and kind = 'file'`,
      [ownerId],
    );
    return { folders: folders.rows.map((row) => row.name), files: files.rows[0].n };
  } finally {
    await client.end();
  }
}

async function serverCounts() {
  const client = database();
  await client.connect();
  try {
    const folders = await client.query(
      `select name from vault_portfolio where user_id = $1 and not deleted order by name`,
      [userId],
    );
    const files = await client.query(
      `select count(*)::int as n from vault_doc where user_id = $1 and not deleted and kind = 'file'`,
      [userId],
    );
    return { folders: folders.rows.map((row) => row.name), files: files.rows[0].n };
  } finally {
    await client.end();
  }
}

let token = "";

async function signIn(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
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
      { email: `${LOGIN}@grafito.app`, password: PASSWORD },
    );
    assert.equal(result.status, 200, "sign-in");
    token = result.token;
  }
  await context.addInitScript((value) => {
    localStorage.setItem("grafito-auth.bearer-token", value);
  }, token);
  return { context, page };
}

/**
 * Drop a folder tree on a sidebar portfolio the way a browser hands it over: filesystem entries
 * from webkitGetAsEntry, so folders keep their paths and empty folders arrive too.
 * tree: { name: { file: [size, base64?] } | { folder: tree } }.
 */
async function dropTree(page, selector, tree) {
  await page.evaluate(
    ({ selector, tree }) => {
      const makeFile = (name, [size, b64]) =>
        new File(
          [b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(size)],
          name,
        );
      const entry = (name, node) =>
        "folder" in node
          ? {
              isFile: false,
              isDirectory: true,
              name,
              createReader: () => {
                let done = false;
                return {
                  readEntries: (ok) => {
                    const list = done
                      ? []
                      : Object.entries(node.folder).map(([child, value]) => entry(child, value));
                    done = true;
                    setTimeout(() => ok(list));
                  },
                };
              },
            }
          : { isFile: true, isDirectory: false, name, file: (ok) => ok(makeFile(name, node.file)) };
      const roots = Object.entries(tree).map(([name, node]) => entry(name, node));
      const data = {
        types: ["Files"],
        files: [],
        items: roots.map((root) => ({ kind: "file", webkitGetAsEntry: () => root })),
        dropEffect: "copy",
        effectAllowed: "all",
        getData: () => "",
      };
      const target = document.querySelector(selector);
      for (const type of ["dragenter", "dragover", "drop"]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: data });
        target.dispatchEvent(event);
      }
    },
    { selector, tree },
  );
}

const MB = 1024 * 1024;

function filesOf(count, size, prefix) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}-${String(index + 1).padStart(2, "0")}.bin`,
      { file: [size] },
    ]),
  );
}

async function counts(page) {
  const text = await page.locator('[data-ui="upload-counts"]').first().textContent();
  const [files, folders] = [...(text ?? "").matchAll(/(\d+) de (\d+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
  return { files, folders };
}

for (const engine of engines) {
  describe(`background uploads (${engine})`, () => {
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
    });

    test("a dropped folder uploads in the background, pauses, resumes elsewhere and reports", async () => {
      const { context, page } = await signIn(browser);
      await page.goto(`${base}/`);
      await page.getByText("e2eup Nota", { exact: true }).first().click();
      const heading = page.locator('[data-ui="editor"]').getByText("Nota abierta durante la carga");
      await heading.waitFor();

      await dropTree(page, '[data-drop-portfolio="e2eup-dest"] button[draggable]', {
        Lote: {
          folder: {
            a: { folder: filesOf(15, 1.5 * MB, "a") },
            b: { folder: { ...filesOf(15, 1.5 * MB, "b"), hondo: { folder: {} } } },
            vacía: { folder: {} },
            "eicar.txt": { file: [68, EICAR_B64] },
          },
        },
      });
      const card = page.locator('[data-ui="upload-queue"] article').first();
      await card.locator("text=Subiendo a «e2eup Destino»").waitFor();
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-ui="upload-counts"]')?.textContent ?? "";
        return Number(/^(\d+)/.exec(text)?.[1] ?? 0) >= 3;
      });
      await card.getByRole("button", { name: "Pausar" }).click();
      await page.locator('article[data-job="paused"]').waitFor();
      const paused = await counts(page);
      await page.waitForTimeout(2500);
      assert.deepEqual(await counts(page), paused, "nothing moves while paused");
      assert.ok(paused.files[0] < 30, "paused before the end");
      assert.equal(paused.folders[1], 5, "five folders, two of them empty");
      // The note that was open is still open; nothing navigated.
      assert.equal(await heading.isVisible(), true);

      // Elsewhere in the app the job is still there and resumes.
      await page.getByRole("button", { name: "Cuenta", exact: true }).click();
      await page.getByRole("menuitem", { name: "Cuenta" }).click();
      await page.waitForURL(/\/cuenta/);
      await page.locator('article[data-job="paused"]').waitFor();
      await page
        .locator('[data-ui="upload-queue"]')
        .getByRole("button", { name: "Reanudar", exact: true })
        .click();
      await page.locator('article[data-job="done"]').waitFor({ timeout: WAIT });
      const summary = page.locator('[data-ui="upload-summary"]').first();
      assert.match((await summary.textContent()) ?? "", /Archivos subidos\s*30/);
      assert.match((await summary.textContent()) ?? "", /Carpetas creadas o ya existentes\s*5/);
      assert.match((await summary.textContent()) ?? "", /Rechazados por el antivirus\s*1/);
      await summary.getByText("Ver detalle").click();
      await summary
        .getByText(/El antivirus detectó una amenaza \(Eicar-Test-Signature\)/)
        .waitFor();
      assert.equal(await summary.locator('[data-state="infected"]').count(), 1);

      // The server has every folder, empty ones included, and every clean file.
      const deadline = Date.now() + 30_000;
      let server = await serverCounts();
      while (server.files < 30 && Date.now() < deadline) {
        await page.waitForTimeout(1000);
        server = await serverCounts();
      }
      assert.equal(server.files, 30);
      for (const name of ["Lote", "a", "b", "hondo", "vacía"])
        assert.ok(server.folders.includes(name), `folder ${name}`);

      // Counts on the portfolio page, as a file manager shows them.
      await page
        .locator('[data-ui="upload-queue"]')
        .getByRole("button", { name: "Cerrar", exact: true })
        .click();
      await page.goto(`${base}/`);
      await page.locator('[data-pick="port:e2eup-dest"]').waitFor();
      await page.getByRole("button", { name: "Lote", exact: true }).click();
      await page.locator('[data-ui="folder-count"]').filter({ hasText: "3 carpetas" }).waitFor();
      assert.equal(
        (await page.locator('[data-ui="folder-count"]').first().textContent())?.trim(),
        "3 carpetas · 0 archivos · en total: 4 carpetas · 30 archivos",
      );
      await context.close();
    });

    test("cancel stops the job and says what did not upload", async () => {
      const { context, page } = await signIn(browser);
      await page.goto(`${base}/`);
      await page.locator('[data-drop-portfolio="e2eup-dest"]').first().waitFor();
      const before = (await serverCounts()).files;
      await dropTree(page, '[data-drop-portfolio="e2eup-dest"] button[draggable]', {
        Cancelada: { folder: filesOf(20, 1.5 * MB, "c") },
      });
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-ui="upload-counts"]')?.textContent ?? "";
        return Number(/^(\d+)/.exec(text)?.[1] ?? 0) >= 2;
      });
      await page
        .locator('[data-ui="upload-queue"]')
        .getByRole("button", { name: "Cancelar", exact: true })
        .click();
      await page.locator('article[data-job="cancelled"]').waitFor();
      const summary = page.locator('[data-ui="upload-summary"]').first();
      const text = (await summary.textContent()) ?? "";
      const done = Number(/Archivos subidos\s*(\d+)/.exec(text)?.[1]);
      const left = Number(/Sin subir\s*(\d+)/.exec(text)?.[1]);
      assert.ok(done >= 2 && done < 20, `uploaded ${done}`);
      assert.equal(done + left, 20);
      await page.waitForTimeout(3000);
      assert.equal((await serverCounts()).files - before, done, "server holds what was uploaded");
      await page
        .locator('[data-ui="upload-queue"]')
        .getByRole("button", { name: "Cerrar", exact: true })
        .click();
      assert.equal(await page.locator('[data-ui="upload-queue"]').count(), 0);
      await context.close();
    });

    test("a folder dropped on an editable shared portfolio goes through the same queue", async () => {
      const { context, page } = await signIn(browser);
      await page.goto(`${base}/`);
      await page.getByText("Compartidos conmigo").first().click();
      const row = page.locator('[data-drop-share="e2eup-share"]');
      await row.waitFor();
      // A new name each run: the seed deletes rows directly, which cached shared trees miss.
      const folder = `Remoto ${Date.now()}`;
      await dropTree(page, '[data-drop-share="e2eup-share"]', {
        [folder]: {
          folder: {
            ...filesOf(4, 200 * 1024, "r"),
            vacía: { folder: {} },
            "eicar.txt": { file: [68, EICAR_B64] },
          },
        },
      });
      await page.locator('article[data-job="done"]').waitFor({ timeout: WAIT });
      const summary = page.locator('[data-ui="upload-summary"]').first();
      const text = (await summary.textContent()) ?? "";
      assert.match(text, /Archivos subidos\s*4/);
      assert.match(text, /Carpetas creadas o ya existentes\s*2/);
      assert.match(text, /Rechazados por el antivirus\s*1/);
      const owner = await ownerCounts();
      assert.equal(owner.files, 4);
      assert.ok(owner.folders.includes(folder) && owner.folders.includes("vacía"));
      await context.close();
    });
  });
}
