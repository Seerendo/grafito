/**
 * Central pages and the sample documentation in real browser engines against the local test
 * stack (project grafito-e2e): portfolios fold and unfold on the central page, and sample
 * documentation the person deleted does not come back (reload, another browser, or a browser
 * that still held it and edited it). Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:8080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_BROWSERS=chromium,firefox \
 *   node --test tests/e2e/vault-pages.e2e.mjs
 *
 * Each run creates fresh "e2evp-" members, so the first open is a brand-new vault.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const engines = (process.env.E2E_BROWSERS ?? "chromium,firefox").split(",");
const PASSWORD = process.env.E2E_PASSWORD ?? "Prueba-Paginas-2026";
const WAIT = 60_000;

function database() {
  return new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:5432/grafito",
  });
}

async function member(prefix) {
  const login = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const id = `e2evp-${randomUUID()}`;
  const client = database();
  await client.connect();
  try {
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, false, now(), now())`,
      [id, login, `${login}@grafito.app`],
    );
    await client.query(
      `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), id, await hashPassword(PASSWORD)],
    );
    await client.query(
      `insert into app_user_role (user_id, role_id, login_name) values ($1, 'miembro', $2)`,
      [id, login],
    );
  } finally {
    await client.end();
  }
  return { id, login };
}

async function samples(userId) {
  const client = database();
  await client.connect();
  try {
    const rows = await client.query(
      `select count(*) filter (where not deleted)::int as live, count(*) filter (where deleted)::int as gone
       from vault_doc where user_id = $1 and id like 'n-%'`,
      [userId],
    );
    return rows.rows[0];
  } finally {
    await client.end();
  }
}

async function until(check, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const tokens = new Map();

async function open(browser, who) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  if (!tokens.has(who.login)) {
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
      { email: `${who.login}@grafito.app`, password: PASSWORD },
    );
    assert.equal(result.status, 200, "sign-in");
    tokens.set(who.login, result.token);
  }
  // Navigating away from a page that is still hydrating breaks WebKit's next page: with a token
  // already in hand, go straight to the vault.
  await context.addInitScript((value) => {
    localStorage.setItem("grafito-auth.bearer-token", value);
  }, tokens.get(who.login));
  await page.goto(`${base}/`);
  return { context, page };
}

const sidebar = (page) => page.locator('[data-ui="sidebar"]');

async function deleteSamples(page) {
  await sidebar(page)
    .getByRole("button", { name: "Documentación", exact: true })
    .click({ button: "right" });
  await page.getByText("Eliminar", { exact: true }).first().click();
  await page.getByRole("button", { name: "Eliminar portafolio" }).click();
}

for (const engine of engines) {
  describe(`central pages and sample documentation (${engine})`, () => {
    let browser;
    before(async () => {
      browser =
        engine === "chrome"
          ? await playwright.chromium.launch({ channel: "chrome" })
          : await playwright[engine].launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("portfolios fold and unfold on the central page", async () => {
      const who = await member("e2evp-fold");
      const { context, page } = await open(browser, who);
      await sidebar(page).getByRole("button", { name: "Documentación", exact: true }).waitFor();
      // Home page: the sample root folds in place, two levels deep.
      await page.getByRole("button", { name: "Carpeta Personal" }).first().click();
      const board = page.locator("[data-home]").first();
      await board.getByRole("button", { name: "Desplegar Documentación" }).click();
      await board.getByRole("button", { name: "Desplegar Inicio" }).click();
      await board.getByRole("button", { name: "Bienvenida" }).waitFor();
      assert.equal(
        await board.getByRole("button", { name: "Plegar Inicio" }).getAttribute("aria-expanded"),
        "true",
      );
      // A document opens from the unfolded tree.
      await board.getByRole("button", { name: "Bienvenida" }).click();
      await page.locator('[data-ui="editor"]').getByText("Bienvenida").first().waitFor();
      // Back home the tree is as it was; folding hides the contents.
      await page.getByRole("button", { name: "Carpeta Personal" }).first().click();
      await board.getByRole("button", { name: "Bienvenida" }).waitFor();
      await board.getByRole("button", { name: "Plegar Documentación" }).click();
      assert.equal(await board.getByRole("button", { name: "Bienvenida" }).count(), 0);
      // A portfolio page folds its own portfolios too.
      await sidebar(page).getByRole("button", { name: "Documentación", exact: true }).click();
      const portfolio = page.locator('[data-ui="portfolio-board"]');
      await portfolio.getByRole("button", { name: "Desplegar Atlas" }).click();
      await portfolio.getByRole("button", { name: "Fuentes" }).waitFor();
      await portfolio.getByRole("button", { name: "Plegar Atlas" }).click();
      assert.equal(await portfolio.getByRole("button", { name: "Fuentes" }).count(), 0);
      await context.close();
    });

    test("deleted sample documentation does not come back", async () => {
      const who = await member("e2evp-seed");
      const first = await open(browser, who);
      await until(async () => (await samples(who.id)).live === 13, "sample pushed");

      // A second browser that already holds the sample, then goes offline.
      const stale = await open(browser, who);
      await sidebar(stale.page)
        .getByRole("button", { name: "Documentación", exact: true })
        .waitFor();
      await stale.page.waitForTimeout(1500);
      await stale.context.setOffline(true);

      await deleteSamples(first.page);
      await until(async () => (await samples(who.id)).live === 0, "sample deleted");
      await first.page.reload();
      await first.page.waitForTimeout(3000);
      assert.equal((await samples(who.id)).live, 0, "reload does not bring it back");
      assert.equal(
        await sidebar(first.page)
          .getByRole("button", { name: "Documentación", exact: true })
          .count(),
        0,
      );

      const fresh = await open(browser, who);
      await fresh.page.waitForTimeout(3000);
      assert.equal((await samples(who.id)).live, 0, "a new browser does not bring it back");
      assert.equal(
        await sidebar(fresh.page).getByRole("button", { name: "Bienvenida" }).count(),
        0,
      );

      // The offline browser edits a sample note, then comes back online.
      await sidebar(stale.page).getByRole("button", { name: "Bienvenida" }).click();
      await stale.page.getByRole("button", { name: "Editar" }).click();
      await stale.page.keyboard.press("Control+End");
      await stale.page.keyboard.type(" editado sin conexión");
      await stale.page.waitForTimeout(2000);
      await stale.context.setOffline(false);
      await stale.page.evaluate(() => window.dispatchEvent(new Event("online")));
      await until(
        async () =>
          (await sidebar(stale.page).getByRole("button", { name: "Bienvenida" }).count()) === 0,
        "the stale browser drops the note",
      );
      assert.equal((await samples(who.id)).live, 0, "the edit does not bring it back");

      // Asking for it explicitly does bring it back.
      await fresh.page
        .getByRole("button", { name: /^Buscar/ })
        .first()
        .click();
      await fresh.page.getByText("Restaurar notas de ejemplo").click();
      await fresh.page.getByRole("button", { name: "Restaurar", exact: true }).click();
      await until(async () => (await samples(who.id)).live === 13, "sample restored on request");
      for (const session of [first, fresh, stale]) await session.context.close();
    });
  });
}
