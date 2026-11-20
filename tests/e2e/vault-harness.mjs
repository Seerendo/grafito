/**
 * Shared pieces of the import, trash and no-OCR browser tests (bulk-import, trash, no-ocr):
 * fresh members, sign-in, folder drops the way a browser hands them over, gates that hold
 * responses until the test lets them through (order of arrival without sleeps), and reads of
 * the server's state. Each test file creates its own members, with its own prefix.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
export const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
export const engines = (process.env.E2E_BROWSERS ?? "chromium").split(",");
export const WAIT = 120_000;
const PASSWORD = process.env.E2E_PASSWORD ?? "Prueba-Carga-2026";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:5432/grafito";

export async function query(text, values = []) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Poll the database (not the app) until check passes; the app is never slowed down by it. */
export async function until(check, label, ms = WAIT) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A fresh member with an empty vault holding one destination portfolio. */
export async function member(prefix) {
  const login = `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const userId = `${prefix}-${randomUUID()}`;
  const email = `${login}@grafito.app`;
  await query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [userId, login, email],
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
  const state = await query(
    `insert into vault_state (user_id, revision) values ($1, 1) returning revision`,
    [userId],
  );
  await query(
    `insert into vault_portfolio (user_id, id, name, parent_id, rev) values ($1, $2, 'Destino', null, $3)`,
    [userId, `${prefix}-dest-${userId.slice(-8)}`, Number(state[0].revision)],
  );
  return { userId, email, dest: `${prefix}-dest-${userId.slice(-8)}` };
}

/**
 * A new destination portfolio for one test, so tests of one member stay apart (sign-in is rate
 * limited on the gateway: one member per test file). A new tab picks it up when it opens.
 */
export async function destination(who) {
  const id = `${who.dest}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const state = await query(
    `update vault_state set revision = revision + 1 where user_id = $1 returning revision`,
    [who.userId],
  );
  await query(
    `insert into vault_portfolio (user_id, id, name, parent_id, rev) values ($1, $2, $3, null, $4)`,
    [who.userId, id, `Destino ${id.slice(-6)}`, Number(state[0].revision)],
  );
  return { ...who, dest: id };
}

const tokens = new Map();

/** A signed-in tab. Several contexts of the same member are two sessions of one person. */
export async function signIn(browser, who, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  let token = options.fresh ? "" : (tokens.get(who.email) ?? "");
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
      { email: who.email, password: PASSWORD },
    );
    assert.equal(result.status, 200, "sign-in");
    token = result.token;
    if (!options.fresh) tokens.set(who.email, token);
  }
  await context.addInitScript((value) => {
    localStorage.setItem("grafito-auth.bearer-token", value);
  }, token);
  await page.goto(`${base}/`);
  await page.locator(`[data-drop-portfolio="${who.dest}"] button[draggable]`).first().waitFor();
  return { context, page, token };
}

/**
 * Hold matching responses until released: the request reaches the server, its answer waits.
 * `pass(n)` lets the first n through untouched.
 */
export async function gate(page, pattern, { pass = 0 } = {}) {
  const held = [];
  const delivering = [];
  let open = false;
  let seen = 0;
  const arrived = [];
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    seen += 1;
    for (const wake of arrived.splice(0)) wake();
    if (!open && seen > pass) await new Promise((resolve) => held.push(resolve));
    // A request the page gave up on meanwhile (a cancelled upload, a reload) has no one to
    // answer: that is the case being tested, not a failure of the harness.
    const delivered = route.fulfill({ response }).catch((error) => {
      if (!/already handled|Target page.*closed/i.test(String(error?.message))) throw error;
    });
    delivering.push(delivered);
    await delivered;
  });
  return {
    get seen() {
      return seen;
    },
    get held() {
      return held.length;
    },
    /** Resolves once at least n responses arrived. */
    async reached(n) {
      while (seen < n) await new Promise((resolve) => arrived.push(resolve));
    },
    release() {
      open = true;
      for (const resume of held.splice(0)) resume();
    },
    /**
     * Let everything through and stop matching. Held answers are delivered first: removing the
     * route while one is held would make Playwright send that request again.
     */
    async close() {
      this.release();
      await Promise.all(delivering);
      await page.unroute(pattern);
    },
  };
}

/**
 * Drop a folder tree on a sidebar portfolio the way a browser hands it over (filesystem entries).
 * tree: { name: { file: [size, base64?, mime?] } | { folder: tree } }; several roots = several
 * folders dropped together.
 */
export async function dropTree(page, portfolioId, tree) {
  await page.evaluate(
    ({ selector, tree }) => {
      const makeFile = (name, [size, b64, type]) =>
        new File(
          [b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(size)],
          name,
          { type: type ?? "" },
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
    { selector: `[data-drop-portfolio="${portfolioId}"] button[draggable]`, tree },
  );
}

/** The job card that ends with status (done, cancelled), and its summary text. */
export async function jobEnds(page, status = "done") {
  const card = page.locator(`[data-ui="upload-queue"] article[data-job="${status}"]`).last();
  await card.waitFor({ timeout: 20 * 60_000 });
  return (await card.textContent())?.replace(/\s+/g, " ") ?? "";
}

/** Dismiss every finished job card, so the next job's card is the only one. */
export async function dismissJobs(page) {
  for (;;) {
    const close = page.locator('[data-ui="upload-queue"]').getByRole("button", { name: "Cerrar" });
    if ((await close.count()) === 0) return;
    await close.first().click();
  }
}

export async function pdf(text, pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 0; page < pages; page += 1)
    doc.addPage([400, 300]).drawText(text, { x: 30, y: 200, size: 16, font });
  return Buffer.from(await doc.save()).toString("base64");
}

/** A real Word document, the same bytes the Office text test reads. */
export function docx() {
  const source = readFileSync(new URL("../server/office-text.test.ts", import.meta.url), "utf8");
  const found = /const SAMPLE_DOCX =\s*"([^"]+)"/.exec(source);
  assert.ok(found, "SAMPLE_DOCX fixture");
  return found[1];
}

/**
 * The member's live tree on the server: every folder with its path, every document with the
 * path of its folder. Checks that no document or folder hangs from a folder that is not there.
 */
export async function serverTree(userId, rootId) {
  const all = await query(
    `select id, name, parent_id from vault_portfolio where user_id = $1 and not deleted`,
    [userId],
  );
  const byId = new Map(all.map((row) => [row.id, row]));
  for (const row of all)
    if (row.parent_id) assert.ok(byId.has(row.parent_id), `folder ${row.name} has a live parent`);
  // The destination and what hangs from it; its own name is shown as "Destino".
  const inside = (id) => {
    for (let cursor = byId.get(id); cursor; cursor = byId.get(cursor.parent_id))
      if (cursor.id === rootId) return true;
    return false;
  };
  const pathOf = (id) => {
    const parts = [];
    for (let cursor = byId.get(id); cursor; cursor = byId.get(cursor.parent_id)) {
      parts.unshift(cursor.id === rootId ? "Destino" : cursor.name);
      if (cursor.id === rootId) break;
    }
    return parts.join("/");
  };
  const folders = all.filter((row) => inside(row.id));
  const docs = (
    await query(
      `select id, title, kind, portfolio_id, file_name, file_key, file_size
       from vault_doc where user_id = $1 and not deleted`,
      [userId],
    )
  ).filter((row) => {
    if (row.portfolio_id) assert.ok(byId.has(row.portfolio_id), `${row.title} has a live folder`);
    return row.portfolio_id && inside(row.portfolio_id);
  });
  return {
    folders: folders.map((row) => pathOf(row.id)).sort(),
    files: docs.map((row) => `${pathOf(row.portfolio_id)}/${row.file_name ?? row.title}`).sort(),
    docs,
  };
}

/** Bytes of a file through its own signed link, as the viewer and the download button get it. */
export async function fetchOwnFile(page, docId, download = false) {
  return page.evaluate(
    async ({ docId, download }) => {
      const token = localStorage.getItem("grafito-auth.bearer-token");
      const response = await fetch(`/api/files/${docId}${download ? "?download=1" : ""}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
        size: bytes.length,
        head: String.fromCharCode(...bytes.slice(0, 5)),
      };
    },
    { docId, download },
  );
}
