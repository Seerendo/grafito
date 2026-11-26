/**
 * Security fixes against the local test stack (project grafito-e2e), one test per finding of
 * the security review (security/, not versioned). Each test shows the attack failing now. Not
 * part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   node --test tests/e2e/security.e2e.mjs
 *
 * GRAF-01 needs a throwaway instance on an empty database: set E2E_SETUP_URL (for example
 * http://127.0.0.1:3400), E2E_SETUP_DATABASE_URL and E2E_SETUP_CODE (its GRAFITO_SETUP_CODE).
 * It writes only "e2esec" rows.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const PASSWORD = process.env.E2E_PASSWORD ?? "Prueba-Seguridad-2026";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:15432/grafito";

function database(url = DATABASE_URL) {
  return new pg.Client({ connectionString: url });
}

async function query(text, values = []) {
  const client = database();
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function account(login, role = "miembro") {
  const known = await query(`select id from "user" where email = $1`, [`${login}@grafito.app`]);
  if (known[0]) return String(known[0].id);
  const id = `e2esec-${randomUUID()}`;
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
  await query(`insert into app_user_role (user_id, role_id, login_name) values ($1, $2, $3)`, [
    id,
    role,
    login,
  ]);
  return id;
}

/** A bearer token for login; sign-in is rate limited, so each login signs in once per run. */
const tokens = new Map();
async function token(login) {
  if (tokens.has(login)) return tokens.get(login);
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: `${login}@grafito.app`, password: PASSWORD }),
  });
  assert.equal(response.status, 200, `sign-in ${login}`);
  const value = response.headers.get("set-auth-token");
  tokens.set(login, value);
  return value;
}

const ids = {};

/** The owner shares folder X (read) with the viewer and folder W (edit) with the editor. */
async function seedShares() {
  ids.owner = await account("e2esec-owner");
  ids.viewer = await account("e2esec-viewer");
  ids.editor = await account("e2esec-editor");
  await query(`delete from share_grant where share_id like 'e2esec-%'`);
  await query(`delete from share_item where id like 'e2esec-%'`);
  await query(`delete from upload_claim where user_id = $1`, [ids.editor]);
  await query(`delete from vault_doc where user_id = $1`, [ids.owner]);
  await query(`delete from vault_portfolio where user_id = $1`, [ids.owner]);
  const rev = (
    await query(
      `insert into vault_state (user_id, revision) values ($1, 1)
       on conflict (user_id) do update set revision = vault_state.revision + 1 returning revision`,
      [ids.owner],
    )
  )[0].revision;
  await query(
    `insert into vault_portfolio (user_id, id, name, parent_id, rev) values
       ($1, 'e2esec-x', 'Compartida', null, $2),
       ($1, 'e2esec-y', 'Privada', null, $2),
       ($1, 'e2esec-w', 'Edición', null, $2)`,
    [ids.owner, rev],
  );
  ids.privateKey = `vault/${ids.owner}/${randomUUID()}`;
  await query(
    `insert into vault_doc (user_id, id, title, kind, content, portfolio_id, file_name, file_mime, file_key, file_size,
       created_at, updated_at, created_by, updated_by, rev) values
       ($1, 'e2esec-a', 'Nota compartida', 'markdown', 'texto visible', 'e2esec-x', null, null, null, null, 0, 0, $1, $1, $2),
       ($1, 'e2esec-b', 'Nota privada', 'markdown', 'clave zafiro secreta', 'e2esec-y', null, null, null, null, 0, 0, $1, $1, $2),
       ($1, 'e2esec-f', 'plano', 'file', '', 'e2esec-x', 'plano.txt', 'text/plain', $3, 5, 0, 0, $1, $1, $2)`,
    [ids.owner, rev, ids.privateKey],
  );
  // The file's bytes, so a link to it would serve something.
  const s3 = new (await import("aws4fetch")).AwsClient({
    accessKeyId: "grafito",
    secretAccessKey: "grafito-secret",
    service: "s3",
    region: "us-east-1",
  });
  await s3.fetch(`http://127.0.0.1:19000/grafito/${ids.privateKey}`, {
    method: "PUT",
    body: "plano",
  });
  await query(
    `insert into share_item (id, owner_id, kind, target_id, title, visibility, access) values
       ('e2esec-share', $1, 'portfolio', 'e2esec-x', 'Compartida', 'shared', 'read'),
       ('e2esec-edit', $1, 'portfolio', 'e2esec-w', 'Edición', 'shared', 'edit')`,
    [ids.owner],
  );
  await query(
    `insert into share_grant (share_id, user_id, granted_at) values
       ('e2esec-share', $1, $3), ('e2esec-edit', $2, $3)`,
    [ids.viewer, ids.editor, Date.now()],
  );
}

describe("security fixes", () => {
  let browser;
  before(async () => {
    await seedShares();
    browser = await playwright.chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
  });
  after(async () => {
    await browser?.close();
    await query(`delete from share_grant where share_id like 'e2esec-%'`);
    await query(`delete from share_item where id like 'e2esec-%'`);
  });

  test("GRAF-02: an anonymous visit no longer deletes an administrator", async () => {
    await query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ('e2esec-legacy', 'legacy', 'e2esec-legacy@grafito.app', false, now(), now())
       on conflict do nothing`,
    );
    await query(
      `insert into app_admin (user_id, must_change_password, login_name, chosen)
       values ('e2esec-legacy', true, 'legacy', false) on conflict do nothing`,
    );
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    await page.context().close();
    const left = await query(`select id from "user" where id = 'e2esec-legacy'`);
    assert.equal(left.length, 1, "the account is still there");
    await query(`delete from "user" where id = 'e2esec-legacy'`);
  });

  test("GRAF-03: a crafted search with the owner's id returns nothing of the owner", async () => {
    const context = await browser.newContext();
    await context.addInitScript(
      (value) => {
        localStorage.setItem("grafito-auth.bearer-token", value);
      },
      await token("e2esec-viewer"),
    );
    const page = await context.newPage();
    let captured = null;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/_serverFn/") &&
        (request.postData() ?? "").includes("zafiro")
      )
        captured = { url: request.url(), body: request.postData(), headers: request.headers() };
    });
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("zafiro");
    await page.waitForTimeout(3000);
    assert.ok(captured, "the search request was seen");
    const answer = await page.evaluate(
      async ({ url, body, headers, owner }) => {
        const crafted = body
          .replace('"k":["q"]', '"k":["q","ownerId"]')
          .replace(/("s":"zafiro"\})/, `$1,{"t":1,"s":"${owner}"}`);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": headers["content-type"],
            "x-tsr-serverfn": headers["x-tsr-serverfn"] ?? "true",
          },
          body: crafted,
        });
        return response.text();
      },
      { ...captured, owner: ids.owner },
    );
    assert.doesNotMatch(answer, /Nota privada|zafiro secreta/);
    await context.close();
  });

  test("GRAF-10: a file link issued through a share stops when the share goes", async () => {
    const response = await fetch(`${base}/api/shared/e2esec-share/tree?fresh=1`, {
      headers: { authorization: `Bearer ${await token("e2esec-viewer")}` },
    });
    assert.equal(response.status, 200);
    const tree = await response.text();
    const link = /\/api\/files\/e2esec-f\?[^"\\]+/.exec(tree)?.[0];
    assert.ok(link, "the tree carries a signed link to the file");
    assert.equal((await fetch(`${base}${link}`)).status, 200, "served while shared");
    await query(`delete from share_grant where share_id = 'e2esec-share'`);
    assert.equal((await fetch(`${base}${link}`)).status, 403, "refused once withdrawn");
    assert.match(link, /[?&]h=e2esec-share/);
    // A link without its share, or with another one, does not verify.
    const stripped = link.replace(/&h=e2esec-share/, "");
    assert.equal((await fetch(`${base}${stripped}`)).status, 403);
    await query(
      `insert into share_grant (share_id, user_id, granted_at) values ('e2esec-share', $1, $2)`,
      [ids.viewer, Date.now()],
    );
  });

  test("GRAF-23: an editor cannot file another key of the owner into the shared folder", async () => {
    // The editor uploads a file into the folder shared with edit access, the way the app does,
    // and the request that files it is replayed with the key of the owner's other file.
    const context = await browser.newContext();
    await context.addInitScript(
      (value) => {
        localStorage.setItem("grafito-auth.bearer-token", value);
      },
      await token("e2esec-editor"),
    );
    const page = await context.newPage();
    let captured = null;
    page.on("request", (request) => {
      const body = request.postData() ?? "";
      if (
        request.method() === "POST" &&
        request.url().includes("/_serverFn/") &&
        body.includes("e2esec-edit") &&
        body.includes("subida.txt") &&
        // The request that files the upload, not the vault sync.
        !body.includes("deletedDocs")
      )
        captured = { url: request.url(), body, headers: request.headers() };
    });
    await page.goto(`${base}/`);
    await page.getByText("Compartidos conmigo").first().click();
    const row = page.locator('[data-drop-share="e2esec-edit"]');
    await row.waitFor();
    await page.evaluate(() => {
      const file = new File(["hola"], "subida.txt", { type: "text/plain" });
      const data = {
        types: ["Files"],
        files: [file],
        items: [{ kind: "file", webkitGetAsEntry: () => null }],
        getData: () => "",
      };
      const target = document.querySelector('[data-drop-share="e2esec-edit"]');
      for (const type of ["dragenter", "dragover", "drop"]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: data });
        target.dispatchEvent(event);
      }
    });
    await page.waitForTimeout(4000);
    assert.ok(captured, "the request that files the upload was seen");
    const before = await query(
      `select count(*)::int as n from vault_doc where user_id = $1 and file_key = $2 and not deleted`,
      [ids.owner, ids.privateKey],
    );
    const answer = await page.evaluate(
      async ({ url, body, headers, key }) => {
        const crafted = body
          .replace(/"s":"vault\/[^"]+"/, `"s":"${key}"`)
          .replace('"s":"subida.txt"', '"s":"robado.txt"');
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": headers["content-type"],
            "x-tsr-serverfn": headers["x-tsr-serverfn"] ?? "true",
          },
          body: crafted,
        });
        return response.text();
      },
      { ...captured, key: ids.privateKey },
    );
    const after = await query(
      `select count(*)::int as n from vault_doc where user_id = $1 and file_key = $2 and not deleted`,
      [ids.owner, ids.privateKey],
    );
    await context.close();
    assert.equal(
      after[0].n,
      before[0].n,
      `no second document points at it: ${answer.slice(0, 160)}`,
    );
    assert.match(answer, /Esa subida no es tuya/);
  });

  test("GRAF-12: WebDAV counts failures by the address the gateway saw", async () => {
    let last = 0;
    for (let n = 0; n < 22; n += 1) {
      const response = await fetch(`${base}/dav/`, {
        method: "PROPFIND",
        headers: {
          authorization: `Basic ${Buffer.from(`e2esec-nadie:mal-${n}`).toString("base64")}`,
          "x-forwarded-for": `203.0.113.${n}`,
          depth: "0",
        },
      });
      last = response.status;
    }
    assert.equal(last, 429, "rotating the first hop does not avoid the lockout");
  });

  test("GRAF-13: sign-in refuses a callback to another site", async () => {
    // A provider must exist for Better Auth to accept the request at all; no secret is real.
    await query(
      `insert into auth_provider (id, enabled, config) values ('google', true, $1)
       on conflict (id) do update set enabled = true, config = excluded.config`,
      [
        JSON.stringify({
          clientId: "e2esec-cliente",
          clientSecret: "e2esec-secreto",
          tenantId: "",
        }),
      ],
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const accepted = await fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    });
    assert.equal(accepted.status, 200, "the provider is set up and a local callback works");
    const response = await fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://atacante.example",
        "x-forwarded-host": "atacante.example",
      },
      body: JSON.stringify({ provider: "google", callbackURL: "https://atacante.example/" }),
    });
    const text = await response.text();
    await query(`delete from auth_provider where id = 'google'`);
    assert.equal(response.status, 400, text.slice(0, 200));
    assert.match(text, /INVALID_CALLBACK_URL/);
  });

  test("GRAF-14: changing the password ends the other sessions", async () => {
    await query(`delete from "user" where email = 'e2esec-pass@grafito.app'`);
    await account("e2esec-pass");
    const sign = async () => {
      const response = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email: "e2esec-pass@grafito.app", password: PASSWORD }),
      });
      return response.headers.get("set-auth-token");
    };
    // Another device signed in, then the person changes the password from «Cuenta».
    const second = await sign();
    // Better Auth keeps the token before the dot in "session"; Grafito's own lease decides
    // which one may use the API, so the check is on the stored sessions.
    const alive = async (value) =>
      (await query(`select 1 from "session" where token = $1`, [value.split(".")[0]])).length === 1;
    assert.ok(await alive(second), "the second session exists");
    const context = await browser.newContext();
    await context.addInitScript(
      (value) => {
        localStorage.setItem("grafito-auth.bearer-token", value);
      },
      await sign(),
    );
    const page = await context.newPage();
    await page.goto(`${base}/account`);
    await page.getByRole("button", { name: "Contraseña", exact: true }).first().click();
    await page.getByLabel("Contraseña actual").fill(PASSWORD);
    await page.getByLabel("Nueva contraseña").fill("Prueba-Seguridad-2027");
    await page.getByRole("button", { name: "Cambiar contraseña" }).click();
    await page.waitForFunction(() => !document.querySelector("form button[disabled]"));
    await page.waitForTimeout(1500);
    assert.equal(await alive(second), false, "the other session is gone");
    // The device that changed it keeps a live session (the token it holds now).
    const held = await page.evaluate(() => localStorage.getItem("grafito-auth.bearer-token"));
    assert.ok(held && (await alive(held)), "this device stays signed in");
    await context.close();
    await query(`delete from "user" where email = 'e2esec-pass@grafito.app'`);
  });

  test("GRAF-08: the git hook refuses before reading a large anonymous body", async () => {
    const unsigned = await fetch(`${base}/api/git/hook/e2esec-nada`, {
      method: "POST",
      body: "x".repeat(10),
    });
    assert.equal(unsigned.status, 401);
    const link = (await query(`select id from git_link limit 1`))[0];
    if (!link) return;
    const big = await fetch(`${base}/api/git/hook/${link.id}`, {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=00" },
      body: "x".repeat(2 * 1024 * 1024),
    });
    assert.equal(big.status, 413);
  });

  test(
    "GRAF-01: the first administrator needs the installation code, and only one is made",
    {
      skip: !process.env.E2E_SETUP_URL,
    },
    async () => {
      const setup = process.env.E2E_SETUP_URL.replace(/\/+$/, "");
      const code = process.env.E2E_SETUP_CODE;
      const forms = [];
      for (const [name, value] of [
        ["sin-codigo", "MALO-MALO-MALO"],
        ["primero", code],
        ["segundo", code],
      ]) {
        const page = await (await browser.newContext()).newPage();
        await page.goto(`${setup}/`);
        await page.getByLabel("Código de instalación").waitFor();
        await page.getByLabel("Código de instalación").fill(value);
        await page.getByLabel("Usuario").fill(name);
        await page.getByLabel("Contraseña").fill("Clave-Larga-2026");
        forms.push({ page, name });
      }
      await forms[0].page.locator("form button[type=submit]").click();
      await forms[0].page.getByText("El código de instalación no es correcto.").waitFor();
      await Promise.all(
        forms.slice(1).map(({ page }) => page.locator("form button[type=submit]").click()),
      );
      await forms[1].page.waitForTimeout(6000);
      const client = database(process.env.E2E_SETUP_DATABASE_URL);
      await client.connect();
      const admins = (await client.query(`select login_name from app_admin`)).rows;
      await client.end();
      assert.equal(admins.length, 1, `one administrator: ${JSON.stringify(admins)}`);
    },
  );
});
