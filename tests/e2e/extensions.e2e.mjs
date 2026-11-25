/**
 * Extensions in a real browser against the local test stack (project grafito-e2e). Stops and
 * starts the grafeno and latex containers of that stack to check that an extension cannot
 * be turned on without its service, pauses while the service is down and comes back with it,
 * catching up in the background. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_COMPOSE="docker compose -p grafito-e2e -f docker-compose.test.yml" \
 *   node --test tests/e2e/extensions.e2e.mjs
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const COMPOSE =
  process.env.E2E_COMPOSE ?? "docker compose -p grafito-e2e -f docker-compose.test.yml";
const PASSWORD = "Prueba-Extension-2026";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:15432/grafito";

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
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function service(action, name) {
  execSync(`${COMPOSE} ${action} ${name}`, { stdio: "ignore" });
}

describe("extensions", () => {
  let browser;
  let page;
  let userId;
  const stopped = new Set();

  before(async () => {
    const login = `e2eext-${Date.now()}`;
    userId = `e2eext-${randomUUID()}`;
    await query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, false, now(), now())`,
      [userId, login, `${login}@grafito.app`],
    );
    await query(
      `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       values ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, await hashPassword(PASSWORD)],
    );
    await query(
      `insert into app_user_role (user_id, role_id, login_name) values ($1, 'admin', $2)`,
      [userId, login],
    );
    await query(`update app_plugin set enabled = true where id in ('grafo', 'latex')`);
    browser = await playwright.chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    page = await context.newPage();
    page.setDefaultTimeout(90_000);
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
      { email: `${login}@grafito.app`, password: PASSWORD },
    );
    await context.addInitScript((value) => {
      localStorage.setItem("grafito-auth.bearer-token", value);
    }, token);
  });

  after(async () => {
    for (const name of stopped) service("start", name);
    await query(`update app_plugin set enabled = true where id in ('grafo', 'latex')`);
    await browser?.close();
  });

  async function openExtensions() {
    await page.goto(`${base}/admin`);
    await page.getByRole("button", { name: "Extensiones" }).first().click();
    await page.locator("[data-extension]").first().waitFor();
  }

  const row = (id) => page.locator(`[data-extension="${id}"]`);

  async function recheckUntil(id, text) {
    await until(async () => {
      await page.getByRole("button", { name: "Comprobar conexión" }).click();
      await page.getByRole("button", { name: "Comprobar conexión" }).isEnabled();
      await page.waitForTimeout(500);
      const status = await row(id).locator('[data-ui="extension-status"]').innerText();
      return status.startsWith(text);
    }, `${id}: ${text}`);
  }

  test("the page is called Extensiones and every service is connected", async () => {
    await openExtensions();
    for (const id of ["grafo", "latex"])
      assert.match(await row(id).locator('[data-ui="extension-status"]').innerText(), /^Conectada/);
    // OCR was removed: no row for it.
    assert.equal(await row("ocr").count(), 0);
    // Mermaid needs no service: no status line, and its switch works.
    assert.equal(await row("mermaid").locator('[data-ui="extension-status"]').count(), 0);
    assert.equal(await row("mermaid").getByRole("switch").isEnabled(), true);
  });

  test("LaTeX: paused without its service, cannot be turned on, comes back with it", async () => {
    service("stop", "latex");
    stopped.add("latex");
    await openExtensions();
    await recheckUntil("latex", "En pausa: sin conexión");
    // On but paused: the vault hides «Nuevo documento LaTeX».
    await page.goto(`${base}/`);
    await page.locator('[data-ui="sidebar"]').waitFor();
    await page.getByRole("button", { name: "Carpeta Personal" }).first().click();
    await page.getByRole("button", { name: "Nueva nota" }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Nuevo documento LaTeX" }).count(), 0);
    // Turned off, it cannot be turned on again while the service is down.
    await openExtensions();
    await row("latex").getByRole("switch").click();
    await until(
      async () => (await row("latex").getByRole("switch").getAttribute("aria-checked")) === "false",
      "latex off",
    );
    await recheckUntil("latex", "Sin conexión");
    assert.equal(await row("latex").getByRole("switch").isDisabled(), true);
    assert.equal(
      (await query(`select enabled from app_plugin where id = 'latex'`))[0].enabled,
      false,
    );
    // Back: the check passes and it turns on.
    service("start", "latex");
    stopped.delete("latex");
    await recheckUntil("latex", "Conectada");
    await row("latex").getByRole("switch").click();
    await until(
      async () => (await row("latex").getByRole("switch").getAttribute("aria-checked")) === "true",
      "latex on",
    );
    await page.goto(`${base}/`);
    await page.getByRole("button", { name: "Carpeta Personal" }).first().click();
    await page.getByRole("button", { name: "Nuevo documento LaTeX" }).first().waitFor();
  });

  test("Grafo: hidden while Grafeno is down, back with it and caught up", async () => {
    // A synced vault to start from.
    await until(
      async () =>
        (
          await query(
            `select 1 from graph_sync g join vault_state s on s.user_id = g.owner_id
             where g.owner_id = $1 and g.rev >= s.revision`,
            [userId],
          )
        ).length > 0,
      "vault copied to Grafeno",
      120_000,
    );
    service("stop", "grafeno");
    stopped.add("grafeno");
    await openExtensions();
    await recheckUntil("grafo", "En pausa: sin conexión");
    // A note written while Grafeno is down.
    const token = await page.evaluate(() => localStorage.getItem("grafito-auth.bearer-token"));
    const status = await page.evaluate(
      async (value) =>
        (
          await fetch("/api/v1/notes", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
            body: JSON.stringify({
              title: "Nota sin grafo",
              content: "Escrita con Grafeno caído.",
            }),
          })
        ).status,
      token,
    );
    assert.equal(status, 201);
    await page.goto(`${base}/`);
    await page.locator('[data-ui="sidebar"]').waitFor();
    await page.keyboard.press("Control+k");
    await page.getByRole("option").first().waitFor();
    assert.equal(await page.getByRole("option", { name: /Mostrar u ocultar grafo/ }).count(), 0);
    await page.keyboard.press("Escape");
    const behind = await query(
      `select g.rev, s.revision from graph_sync g join vault_state s on s.user_id = g.owner_id
       where g.owner_id = $1`,
      [userId],
    );
    assert.ok(Number(behind[0].rev) < Number(behind[0].revision), "the copy waits for Grafeno");
    // Back: the copy catches up on its own and the graph shows again.
    service("start", "grafeno");
    stopped.delete("grafeno");
    await until(
      async () =>
        (
          await query(
            `select 1 from graph_sync g join vault_state s on s.user_id = g.owner_id
             where g.owner_id = $1 and g.rev >= s.revision`,
            [userId],
          )
        ).length > 0,
      "caught up after Grafeno came back",
      180_000,
    );
    await until(
      async () => {
        await page.goto(`${base}/`);
        await page.locator('[data-ui="sidebar"]').waitFor();
        await page.keyboard.press("Control+k");
        await page.getByRole("option").first().waitFor();
        const shown = await page.getByRole("option", { name: /Mostrar u ocultar grafo/ }).count();
        await page.keyboard.press("Escape");
        return shown > 0;
      },
      "graph shown again",
      120_000,
    );
  });
});
