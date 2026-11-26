/**
 * The MCP server (/api/mcp) against the local test stack (project grafito-e2e), as an MCP client
 * would call it, and the screens without the AI assistant in a real browser. Not part of
 * `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   node --test tests/e2e/mcp.e2e.mjs
 *
 * Each run creates fresh "e2emcp-" members with personal tokens.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const PASSWORD = "Prueba-Mcp-2026";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:15432/grafito";
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

/** A member with a role and a personal token; returns its id, login and token. */
async function member(name, role = "miembro") {
  const login = `e2emcp-${name}-${stamp}`;
  const id = `e2emcp-${randomUUID()}`;
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
  const token = `gft_${randomBytes(32).toString("base64url")}`;
  await query(
    `insert into api_token (id, user_id, name, prefix, token_hash) values ($1, $2, 'e2e', $3, $4)`,
    [randomUUID(), id, token.slice(0, 10), createHash("sha256").update(token).digest("hex")],
  );
  return { id, login, token };
}

let nextId = 1;
async function rpc(token, method, params, raw = false) {
  const response = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (raw) return response;
  assert.equal(response.status, 200, `${method} answered ${response.status}`);
  return response.json();
}

/** Call a tool; returns { error, data } with the tool's JSON answer. */
async function tool(token, name, args = {}) {
  const answer = await rpc(token, "tools/call", { name, arguments: args });
  assert.ok(answer.result, `${name}: ${JSON.stringify(answer.error)}`);
  return {
    error: answer.result.isError,
    data: JSON.parse(answer.result.content[0].text),
  };
}

describe("MCP server", () => {
  let owner;
  let viewer;
  let stranger;
  let reader;
  before(async () => {
    owner = await member("owner");
    viewer = await member("viewer");
    stranger = await member("stranger");
    // A role that can only read through the API.
    const role = `e2emcp-lector-${stamp}`;
    await query(`insert into app_role (id, name, fixed) values ($1, $1, false)`, [role]);
    await query(
      `insert into app_role_permission (role_id, permission_key) values ($1, 'notes.read'), ($1, 'api.use')`,
      [role],
    );
    reader = await member("reader", role);
  });

  test("only a personal token signs in, with the API permission", async () => {
    const none = await rpc(null, "ping", {}, true);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal((await rpc("gft_no-es-un-token", "ping", {}, true)).status, 401);
    assert.equal((await rpc("una-sesion-del-navegador", "ping", {}, true)).status, 401);
    assert.equal((await fetch(`${base}/api/mcp`)).status, 405);
    const role = `e2emcp-sinapi-${stamp}`;
    await query(`insert into app_role (id, name, fixed) values ($1, $1, false)`, [role]);
    await query(
      `insert into app_role_permission (role_id, permission_key) values ($1, 'notes.read')`,
      [role],
    );
    const noApi = await member("noapi", role);
    assert.equal((await rpc(noApi.token, "ping", {}, true)).status, 403);
  });

  test("initialize, notifications and the tool list", async () => {
    const init = await rpc(owner.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "grafito");
    const note = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(note.status, 202);
    const names = (await rpc(owner.token, "tools/list", {})).result.tools.map((item) => item.name);
    for (const name of [
      "whoami",
      "list_portfolios",
      "list_notes",
      "search_notes",
      "read_note",
      "create_note",
      "update_note",
      "create_portfolio",
      "update_portfolio",
      "move_document",
      "delete_note",
      "delete_file",
      "delete_portfolio",
      "list_trash",
      "restore_from_trash",
      "list_versions",
      "read_version",
      "list_comments",
      "add_comment",
      "link_documents",
      "link_pdf_phrase",
      "create_table",
      "query_table",
      "add_table_row",
      "set_table_cell",
      "delete_table_row",
      "graph_overview",
      "graph_neighbors",
      "graph_path",
      "graph_related",
    ])
      assert.ok(names.includes(name), name);
    const deletion = (await rpc(owner.token, "tools/list", {})).result.tools.find(
      (item) => item.name === "delete_note",
    );
    assert.equal(deletion.annotations.destructiveHint, true);
    assert.deepEqual(deletion.inputSchema.required, ["id", "confirm"]);
    const who = await tool(owner.token, "whoami");
    assert.equal(who.data.login, owner.login);
    assert.ok(who.data.permissions.includes("api.use"));
    assert.ok(!who.data.permissions.includes("ai.use"));
  });

  test("notes and portfolios: create, read, rename, move, comment, versions, links", async () => {
    const folder = await tool(owner.token, "create_portfolio", { name: "Proyecto MCP" });
    assert.equal(folder.error, false, JSON.stringify(folder.data));
    const archive = await tool(owner.token, "create_portfolio", { name: "Archivo MCP" });
    const note = await tool(owner.token, "create_note", {
      title: "Acta MCP",
      content: "# Acta MCP\n\nPalabra clave quetzal.",
      portfolio_id: folder.data.id,
    });
    assert.equal(note.error, false, JSON.stringify(note.data));
    const other = await tool(owner.token, "create_note", {
      title: "Destino MCP",
      content: "Otra.",
    });
    const read = await tool(owner.token, "read_note", { id: "Acta MCP" });
    assert.match(read.data.content, /quetzal/);
    assert.equal(read.data.access, "edición");

    const renamed = await tool(owner.token, "update_note", {
      id: note.data.id,
      title: "Acta MCP final",
      content: "# Acta MCP final\n\nSegunda versión.",
    });
    assert.equal(renamed.data.title, "Acta MCP final");
    const moved = await tool(owner.token, "move_document", {
      id: note.data.id,
      portfolio_id: "Archivo MCP",
    });
    assert.equal(moved.error, false, JSON.stringify(moved.data));
    const row = await query(`select portfolio_id from vault_doc where user_id = $1 and id = $2`, [
      owner.id,
      note.data.id,
    ]);
    assert.equal(row[0].portfolio_id, archive.data.id);

    // A portfolio cannot go inside itself; renaming and moving work.
    const loop = await tool(owner.token, "update_portfolio", {
      id: folder.data.id,
      parent_id: folder.data.id,
    });
    assert.equal(loop.error, true);
    const nested = await tool(owner.token, "update_portfolio", {
      id: folder.data.id,
      name: "Proyecto MCP 2026",
      parent_id: archive.data.id,
    });
    assert.equal(nested.error, false, JSON.stringify(nested.data));
    const portfolios = await query(
      `select name, parent_id from vault_portfolio where user_id = $1 and id = $2`,
      [owner.id, folder.data.id],
    );
    assert.deepEqual(portfolios[0], { name: "Proyecto MCP 2026", parent_id: archive.data.id });

    const commented = await tool(owner.token, "add_comment", {
      id: note.data.id,
      body: "Revisado desde MCP",
    });
    assert.equal(commented.error, false);
    const comments = await tool(owner.token, "list_comments", { id: note.data.id });
    assert.equal(comments.data.comments.at(-1).body, "Revisado desde MCP");
    assert.equal(comments.data.comments.at(-1).mine, true);

    const versions = await tool(owner.token, "list_versions", { id: note.data.id });
    assert.equal(versions.error, false);
    if (versions.data.versions.length > 0) {
      const old = await tool(owner.token, "read_version", {
        id: note.data.id,
        version_id: versions.data.versions.at(-1).id,
      });
      assert.equal(old.error, false, JSON.stringify(old.data));
      assert.equal(typeof old.data.content, "string");
    }

    const linked = await tool(owner.token, "link_documents", {
      from: note.data.id,
      to: other.data.id,
    });
    assert.equal(linked.error, false, JSON.stringify(linked.data));
    const links = await query(`select links_json from vault_doc where user_id = $1 and id = $2`, [
      owner.id,
      note.data.id,
    ]);
    assert.match(links[0].links_json, new RegExp(other.data.id));
  });

  test("deleting needs the exact name in confirm; the trash restores it", async () => {
    const note = await tool(owner.token, "create_note", { title: "Borrador MCP", content: "x" });
    const unconfirmed = await tool(owner.token, "delete_note", { id: note.data.id, confirm: "sí" });
    assert.equal(unconfirmed.error, true);
    assert.equal(
      (
        await query(`select deleted from vault_doc where user_id = $1 and id = $2`, [
          owner.id,
          note.data.id,
        ])
      )[0].deleted,
      false,
    );
    const deleted = await tool(owner.token, "delete_note", {
      id: note.data.id,
      confirm: "Borrador MCP",
    });
    assert.equal(deleted.error, false, JSON.stringify(deleted.data));
    const trash = await tool(owner.token, "list_trash");
    assert.ok(trash.data.items.some((item) => item.id === note.data.id));
    const restored = await tool(owner.token, "restore_from_trash", { id: note.data.id });
    assert.equal(restored.error, false, JSON.stringify(restored.data));
    assert.equal(
      (
        await query(`select deleted from vault_doc where user_id = $1 and id = $2`, [
          owner.id,
          note.data.id,
        ])
      )[0].deleted,
      false,
    );
  });

  test("tables: rows are added, read and deleted with confirmation", async () => {
    const table = await tool(owner.token, "create_table", {
      title: "Inventario MCP",
      columns: "Nombre, Cantidad",
    });
    assert.equal(table.error, false, JSON.stringify(table.data));
    const added = await tool(owner.token, "add_table_row", {
      table: table.data.id,
      cells: JSON.stringify({ Nombre: "Tornillos", Cantidad: "12" }),
    });
    assert.equal(added.error, false, JSON.stringify(added.data));
    const rows = await tool(owner.token, "query_table", { table: table.data.id });
    assert.equal(rows.data.rows[0].Nombre, "Tornillos");
    const refused = await tool(owner.token, "delete_table_row", {
      table: table.data.id,
      row_id: added.data.rowId,
      confirm: "",
    });
    assert.equal(refused.error, true);
    const removed = await tool(owner.token, "delete_table_row", {
      table: table.data.id,
      row_id: added.data.rowId,
      confirm: added.data.rowId,
    });
    assert.equal(removed.error, false, JSON.stringify(removed.data));
    assert.equal(
      (await tool(owner.token, "query_table", { table: table.data.id })).data.rows.length,
      0,
    );
  });

  test("roles and access: a read-only role gets no write tools; others' notes stay private", async () => {
    const names = (await rpc(reader.token, "tools/list", {})).result.tools.map((item) => item.name);
    assert.ok(names.includes("read_note"));
    for (const name of ["create_note", "delete_note", "move_document", "add_table_row"])
      assert.ok(!names.includes(name), name);
    const blocked = await rpc(reader.token, "tools/call", {
      name: "create_note",
      arguments: { title: "No", content: "No" },
    });
    assert.equal(blocked.error.code, -32602);

    const secret = await tool(owner.token, "create_note", {
      title: "Privada MCP",
      content: "clave zafiro",
    });
    const peek = await tool(stranger.token, "read_note", { id: secret.data.id });
    assert.equal(peek.error, true);
    assert.doesNotMatch(JSON.stringify(peek.data), /zafiro/);
    const steal = await tool(stranger.token, "delete_note", {
      id: secret.data.id,
      confirm: "Privada MCP",
    });
    assert.equal(steal.error, true);
  });

  test("a read-only share: read and comment, but no edits", async () => {
    const folder = await tool(owner.token, "create_portfolio", { name: "Compartida MCP" });
    const note = await tool(owner.token, "create_note", {
      title: "Nota compartida MCP",
      content: "Texto para quien lo vea.",
      portfolio_id: folder.data.id,
    });
    const shareId = `e2emcp-share-${stamp}`;
    await query(
      `insert into share_item (id, owner_id, kind, target_id, title, visibility, access)
       values ($1, $2, 'portfolio', $3, 'Compartida MCP', 'shared', 'read')`,
      [shareId, owner.id, folder.data.id],
    );
    await query(`insert into share_grant (share_id, user_id, granted_at) values ($1, $2, $3)`, [
      shareId,
      viewer.id,
      Date.now(),
    ]);
    const read = await tool(viewer.token, "read_note", { id: note.data.id });
    assert.equal(read.error, false, JSON.stringify(read.data));
    assert.equal(read.data.access, "lectura");
    const edit = await tool(viewer.token, "update_note", { id: note.data.id, content: "cambio" });
    assert.equal(edit.error, true);
    const comment = await tool(viewer.token, "add_comment", {
      id: note.data.id,
      body: "Comentario de lectura",
    });
    assert.equal(comment.error, false, JSON.stringify(comment.data));
    const ownerSees = await tool(owner.token, "list_comments", { id: note.data.id });
    assert.ok(ownerSees.data.comments.some((item) => item.body === "Comentario de lectura"));
    const move = await tool(viewer.token, "move_document", {
      id: note.data.id,
      portfolio_id: "root",
    });
    assert.equal(move.error, true);
  });

  describe("screens without the assistant", () => {
    let browser;
    let page;
    before(async () => {
      browser = await playwright.chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      page = await context.newPage();
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
        { email: `${owner.login}@grafito.app`, password: PASSWORD },
      );
      await context.addInitScript((value) => {
        localStorage.setItem("grafito-auth.bearer-token", value);
      }, token);
    });
    after(async () => {
      await browser?.close();
    });

    test("no chat in the vault, and Ctrl+B opens nothing", async () => {
      await page.goto(`${base}/`);
      await page.locator('[data-ui="sidebar"]').waitFor();
      await page.keyboard.press("Control+b");
      await page.waitForTimeout(800);
      assert.equal(await page.getByRole("button", { name: /Chat de IA|AI chat/ }).count(), 0);
      assert.equal(await page.getByLabel(/Mensaje para la IA|Message to the AI/).count(), 0);
    });

    test("Account shows the MCP address and no AI connections", async () => {
      await page.goto(`${base}/account`);
      await page.getByRole("button", { name: /API/ }).first().waitFor();
      assert.equal(await page.getByText("Conexiones de IA").count(), 0);
      await page.getByRole("button", { name: /API/ }).first().click();
      const url = page.locator('[data-ui="mcp-url"] code');
      await page.waitForFunction(() =>
        document.querySelector('[data-ui="mcp-url"] code')?.textContent?.endsWith("/api/mcp"),
      );
      assert.equal(await url.innerText(), `${base}/api/mcp`);
      await page.screenshot({ path: process.env.E2E_SHOT ?? "mcp-account.png" });
    });
  });
});
