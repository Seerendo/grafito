/**
 * LaTeX documents in a real browser against the local test stack (project grafito-e2e) with the
 * latex service. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   node --test tests/e2e/latex.e2e.mjs
 *
 * Each run creates a fresh "e2elx-" member.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const PASSWORD = "Prueba-Latex-2026";
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

async function until(check, label, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe("LaTeX documents", () => {
  let browser;
  let page;
  let userId;
  before(async () => {
    const login = `e2elx-${Date.now()}`;
    userId = `e2elx-${randomUUID()}`;
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
      `insert into app_user_role (user_id, role_id, login_name) values ($1, 'miembro', $2)`,
      [userId, login],
    );
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
    await page.goto(`${base}/`);
    await page.locator('[data-ui="sidebar"]').waitFor();
  });
  after(async () => {
    await browser?.close();
  });

  test("a LaTeX document is created, compiled, edited, saved and searchable", async () => {
    await page.getByRole("button", { name: "Carpeta Personal" }).first().click();
    await page.getByRole("button", { name: "Nuevo documento LaTeX" }).first().click();
    const view = page.locator('[data-ui="latex"]');
    await view.waitFor();
    // The template compiles to a PDF shown on the right.
    await view.locator("canvas").first().waitFor({ timeout: 120_000 });
    const source = view.getByLabel("Código LaTeX");
    const before = (
      await query(`select file_key from vault_doc where user_id = $1 and file_name like '%.tex'`, [
        userId,
      ])
    )[0]?.file_key;
    assert.ok(before, "the .tex document reached the server");

    // An error names its line.
    await source.click();
    await page.keyboard.press("Control+End");
    await source.press("Control+Home");
    await source.evaluate((area) => {
      area.focus();
    });
    const original = await source.inputValue();
    await source.fill(
      original.replace("\\section{Introducción}", "\\section{Introducción}\n\\comandoinexistente"),
    );
    await view.getByRole("button", { name: "Compilar" }).click();
    await view
      .locator('[data-ui="latex-error"]')
      .getByText(/Línea \d+: Undefined control sequence/)
      .waitFor();

    // A fixed source saves a new version and compiles again.
    await source.fill(original.replace("Escribe aquí.", "Palabra clave ornitorrinco."));
    await source.press("Control+s");
    await until(async () => {
      const now = (
        await query(
          `select file_key from vault_doc where user_id = $1 and file_name like '%.tex'`,
          [userId],
        )
      )[0]?.file_key;
      return now && now !== before;
    }, "a new version");
    await view.locator('[data-ui="latex-error"]').waitFor({ state: "detached" });
    await view.locator("canvas").first().waitFor();
    // The source is indexed as text.
    await until(
      async () =>
        (
          await query(
            `select 1 from doc_index where user_id = $1 and body ilike '%ornitorrinco%'`,
            [userId],
          )
        ).length > 0,
      "the .tex text in the index",
    );
  });

  test("a bibliography (biblatex + biber) and XeLaTeX compile from the browser", async () => {
    const view = page.locator('[data-ui="latex"]');
    const source = view.getByLabel("Código LaTeX");
    const compiles = async (text) => {
      await source.fill(text);
      await view.getByRole("button", { name: "Compilar" }).click();
      await view
        .getByRole("button", { name: "Compilando…" })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);
      await view.getByRole("button", { name: "Compilar" }).waitFor({ timeout: 150_000 });
      assert.equal(await view.locator('[data-ui="latex-error"]').count(), 0);
      await view.locator("canvas").first().waitFor();
    };
    await compiles(
      [
        "\\documentclass{article}",
        "\\usepackage[spanish]{babel}",
        "\\begin{filecontents*}[overwrite]{refs.bib}",
        "@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}",
        "\\end{filecontents*}",
        "\\usepackage[backend=biber,style=authoryear]{biblatex}",
        "\\addbibresource{refs.bib}",
        "\\begin{document}",
        "Según \\textcite{knuth}.",
        "\\printbibliography",
        "\\end{document}",
      ].join("\n"),
    );
    await compiles(
      [
        "% !TEX program = xelatex",
        "\\documentclass{article}",
        "\\usepackage{fontspec}",
        "\\setmainfont{Libertinus Serif}",
        "\\setsansfont{Fira Sans}",
        "\\begin{document}",
        "Hola, ñandú.",
        "\\end{document}",
      ].join("\n"),
    );
  });
});
