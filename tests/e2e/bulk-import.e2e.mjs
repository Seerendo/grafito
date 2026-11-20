/**
 * Folder imports (T01–T12) in a real browser against the local test stack (project
 * grafito-e2e). Order of arrival is controlled by holding responses (vault-harness gate), never
 * by sleeping. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:8080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_BROWSERS=chromium,firefox \
 *   node --test tests/e2e/bulk-import.e2e.mjs
 *
 * Each run creates fresh "e2ebi-" members.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  destination,
  dismissJobs,
  docx,
  dropTree,
  engines,
  fetchOwnFile,
  gate,
  jobEnds,
  member,
  pdf,
  playwright,
  query,
  serverTree,
  signIn,
  until,
} from "./vault-harness.mjs";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** count PDFs named prefix-NN.pdf. */
async function pdfs(count, prefix) {
  const bytes = await pdf(`Documento ${prefix}`);
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}-${String(index + 1).padStart(3, "0")}.pdf`,
      { file: [0, bytes, PDF_MIME] },
    ]),
  );
}

/** Open a document from the command palette, by title. */
async function openByTitle(page, title) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(title);
  await page
    .getByRole("option", { name: new RegExp(title) })
    .first()
    .click();
}

/** Every folder path and file path the tree describes, as serverTree reports them. */
function expected(tree, prefix = "Destino") {
  const folders = [prefix];
  const files = [];
  const walk = (node, path) => {
    for (const [name, value] of Object.entries(node)) {
      if ("folder" in value) {
        folders.push(`${path}/${name}`);
        walk(value.folder, `${path}/${name}`);
      } else files.push(`${path}/${name.replace(/\.(md|markdown)$/i, "")}`);
    }
  };
  walk(tree, prefix);
  return { folders: folders.sort(), files: files.sort() };
}

function fileNames(tree) {
  return tree.files.map((path) => path.replace(/\.(md|markdown)$/i, ""));
}

for (const engine of engines) {
  describe(`folder imports (${engine})`, () => {
    let browser;
    let person;
    /** A fresh destination of this file's member. */
    const fresh = () => destination(person);
    before(async () => {
      person = await member("e2ebi");
      browser =
        engine === "chrome"
          ? await playwright.chromium.launch({ channel: "chrome" })
          : await playwright[engine].launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("T01 a single file is on the server when the queue says so", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      await dropTree(page, who.dest, { "único.pdf": { file: [0, await pdf("único"), PDF_MIME] } });
      assert.match(await jobEnds(page), /Archivos subidos\s*1/);
      const tree = await serverTree(who.userId, who.dest);
      assert.deepEqual(tree.files, ["Destino/único.pdf"]);
      const read = await fetchOwnFile(page, tree.docs[0].id);
      assert.equal(read.status, 200);
      assert.equal(read.head, "%PDF-");
      await context.close();
    });

    test("T02/T04 a whole deep folder keeps every parent, and nothing lands at the top", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      let deep = { "hondo.pdf": { file: [0, await pdf("hondo"), PDF_MIME] } };
      for (let level = 12; level >= 1; level -= 1) deep = { [`n${level}`]: { folder: deep } };
      const tree = {
        Obra: {
          folder: {
            planos: { folder: await pdfs(6, "plano") },
            actas: { folder: { ...(await pdfs(4, "acta")), vacía: { folder: {} } } },
            "notas.md": { file: [0, Buffer.from("# Notas\n\nDe obra.").toString("base64")] },
            ...deep,
          },
        },
      };
      await dropTree(page, who.dest, tree);
      const summary = await jobEnds(page);
      assert.match(summary, /Archivos subidos\s*12/);
      const server = await serverTree(who.userId, who.dest);
      const want = expected(tree);
      assert.deepEqual(server.folders, want.folders);
      assert.deepEqual(fileNames(server), want.files);
      const top = await query(
        `select count(*)::int as n from vault_doc where user_id = $1 and not deleted and portfolio_id is null`,
        [who.userId],
      );
      assert.equal(top[0].n, 0, "no document without its folder");
      assert.equal(server.docs.length, 12);
      await context.close();
    });

    test("T03/T12 several subfolders at once, and the same in pieces, give the same tree", async () => {
      const whole = await fresh();
      const pieces = await fresh();
      const parts = {
        "01-Direccion": {
          folder: { ...(await pdfs(3, "dir")), sub: { folder: await pdfs(2, "s") } },
        },
        "02-Varios": { folder: await pdfs(4, "var") },
        "03-Otros": { folder: { "x.docx": { file: [0, docx(), DOCX_MIME] } } },
      };
      const a = await signIn(browser, whole);
      await dropTree(a.page, whole.dest, { Raiz: { folder: parts } });
      await jobEnds(a.page);
      const b = await signIn(browser, pieces);
      // The same folder dropped as three subfolders, one job after another, into "Raiz".
      await dropTree(b.page, pieces.dest, { Raiz: { folder: {} } });
      await jobEnds(b.page);
      const raiz = await until(async () => {
        const rows = await query(
          `select id from vault_portfolio where user_id = $1 and parent_id = $2 and name = 'Raiz' and not deleted`,
          [pieces.userId, pieces.dest],
        );
        return rows[0]?.id;
      }, "Raiz on the server");
      await b.page.locator(`[data-drop-portfolio="${raiz}"] button[draggable]`).first().waitFor();
      for (const [name, node] of Object.entries(parts)) {
        await dismissJobs(b.page);
        await dropTree(b.page, raiz, { [name]: node });
        await jobEnds(b.page);
      }
      assert.deepEqual(
        (await serverTree(pieces.userId, pieces.dest)).files,
        (await serverTree(whole.userId, whole.dest)).files,
      );
      assert.deepEqual(
        (await serverTree(pieces.userId, pieces.dest)).folders,
        (await serverTree(whole.userId, whole.dest)).folders,
      );
      await a.context.close();
      await b.context.close();
    });

    test("T05/T06/T07 a PDF, an Office file and another PDF open while the queue still runs", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      // The first three files finish; every later answer is held, so the queue keeps running.
      const held = await gate(page, "**/api/files/uploads/complete", { pass: 3 });
      await dropTree(page, who.dest, {
        Cola: {
          folder: {
            "a-primero.pdf": { file: [0, await pdf("primero"), PDF_MIME] },
            "b-informe.docx": { file: [0, docx(), DOCX_MIME] },
            "c-segundo.pdf": { file: [0, await pdf("segundo"), PDF_MIME] },
            ...(await pdfs(12, "resto")),
          },
        },
      });
      await held.reached(4);
      assert.equal(
        await page.locator('[data-ui="upload-queue"] article[data-job="running"]').count(),
        1,
        "the queue is still running",
      );
      await openByTitle(page, "a-primero");
      await page.locator('[data-ui="pdf"] canvas').first().waitFor();
      await openByTitle(page, "b-informe");
      // The editor session is issued (the Office iframe is there), not an error or a wait.
      await page.locator('iframe[name^="office-"]').waitFor();
      assert.equal(await page.locator('[data-ui="office-error"]').count(), 0);
      await openByTitle(page, "c-segundo");
      await page.locator('[data-ui="pdf"] canvas').first().waitFor();
      assert.equal(await page.locator('[data-ui="file-status"]').count(), 0);
      await held.close();
      assert.match(await jobEnds(page), /Archivos subidos\s*15/);
      await context.close();
    });

    test("T08 hundreds of files in many folders, all registered once", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      const tree = {};
      const bytes = await pdf("lote");
      for (let folder = 0; folder < 40; folder += 1) {
        const files = {};
        for (let file = 0; file < 10; file += 1)
          files[`f${folder}-${file}.pdf`] = { file: [0, bytes, PDF_MIME] };
        tree[`c${String(folder).padStart(2, "0")}`] = { folder: files };
      }
      const started = Date.now();
      await dropTree(page, who.dest, { Lote: { folder: tree } });
      assert.match(await jobEnds(page), /Archivos subidos\s*400/);
      const seconds = (Date.now() - started) / 1000;
      const server = await serverTree(who.userId, who.dest);
      assert.equal(server.files.length, 400);
      assert.equal(new Set(server.files).size, 400, "no duplicates");
      console.info(`T08: 400 files, 41 folders in ${seconds.toFixed(1)} s`);
      await context.close();
    });

    test("T09/T10 cancel, then drop again: what arrived is skipped, nothing twice", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      const tree = {
        Repetir: { folder: { a: { folder: await pdfs(10, "a") }, ...(await pdfs(10, "b")) } },
      };
      const held = await gate(page, "**/api/files/uploads/complete", { pass: 6 });
      await dropTree(page, who.dest, tree);
      await held.reached(7);
      await page
        .locator('[data-ui="upload-queue"]')
        .getByRole("button", { name: "Cancelar" })
        .click();
      await held.close();
      await jobEnds(page, "cancelled");
      const afterCancel = (await serverTree(who.userId, who.dest)).files.length;
      // Held answers were registered on the server: the browser shows exactly those.
      const ids = (await serverTree(who.userId, who.dest)).docs.map((doc) => doc.id);
      for (const id of ids)
        await page
          .locator(`[data-ui="sidebar"] [data-pick="doc:${id}"]`)
          .waitFor({ state: "attached" });
      await dismissJobs(page);
      await dropTree(page, who.dest, tree);
      const summary = await jobEnds(page);
      const server = await serverTree(who.userId, who.dest);
      assert.equal(server.files.length, 20);
      assert.equal(new Set(server.files).size, 20, "no duplicates");
      assert.match(summary, new RegExp(`Ya estaban en su carpeta\\s*${afterCancel}`));
      await context.close();
    });

    test("T11 a reload in the middle loses nothing that arrived and sending again completes it", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      const tree = {
        Recarga: {
          folder: {
            ...(await pdfs(12, "r")),
            "nota.md": { file: [0, Buffer.from("# N").toString("base64")] },
          },
        },
      };
      const held = await gate(page, "**/api/files/uploads/complete", { pass: 5 });
      await dropTree(page, who.dest, tree);
      await held.reached(6);
      page.once("dialog", (dialog) => void dialog.accept());
      await held.close();
      await page.reload();
      await page.locator(`[data-drop-portfolio="${who.dest}"] button[draggable]`).first().waitFor();
      const arrived = (await serverTree(who.userId, who.dest)).files.length;
      assert.ok(arrived >= 5 && arrived < 13, `${arrived} arrived before the reload`);
      await dropTree(page, who.dest, tree);
      await jobEnds(page);
      const server = await serverTree(who.userId, who.dest);
      assert.equal(server.files.length, 13);
      assert.equal(new Set(server.files).size, 13);
      await context.close();
    });

    test("T03b two tabs importing the same folders at the same moment make each folder once", async () => {
      const who = await fresh();
      const a = await signIn(browser, who);
      const b = await signIn(browser, who, { fresh: true });
      const tree = {
        Comun: { folder: { uno: { folder: { dos: { folder: {} } } }, tres: { folder: {} } } },
      };
      await Promise.all([dropTree(a.page, who.dest, tree), dropTree(b.page, who.dest, tree)]);
      await Promise.all([jobEnds(a.page), jobEnds(b.page)]);
      const server = await serverTree(who.userId, who.dest);
      assert.deepEqual(server.folders, [
        "Destino",
        "Destino/Comun",
        "Destino/Comun/tres",
        "Destino/Comun/uno",
        "Destino/Comun/uno/dos",
      ]);
      await a.context.close();
      await b.context.close();
    });

    test("T09b the same document sent twice at once is stored once", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      const result = await page.evaluate(
        async ({ dest, bytes }) => {
          const token = localStorage.getItem("grafito-auth.bearer-token");
          const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
          const body = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
          const doc = {
            id: crypto.randomUUID(),
            title: "doble",
            name: "doble.pdf",
            mime: "application/pdf",
            createdAt: Date.now(),
            actor: "e2e",
          };
          // Two whole uploads, then both completions at the same moment with the same document.
          const started = await Promise.all(
            [0, 1].map(async () => {
              const start = await fetch("/api/files/uploads", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  name: doc.name,
                  mime: doc.mime,
                  size: body.length,
                  portfolioId: dest,
                }),
              }).then((response) => response.json());
              const query = new URLSearchParams({
                key: start.key,
                uploadId: start.uploadId,
                part: "1",
              });
              const part = await fetch(`/api/files/uploads/part?${query}`, {
                method: "PUT",
                headers: { authorization: headers.authorization },
                body,
              }).then((response) => response.json());
              return { ...start, etag: part.etag };
            }),
          );
          const done = await Promise.all(
            started.map((one) =>
              fetch("/api/files/uploads/complete", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  key: one.key,
                  uploadId: one.uploadId,
                  parts: [{ part: 1, etag: one.etag }],
                  portfolioId: dest,
                  doc,
                }),
              }).then(async (response) => ({
                status: response.status,
                body: await response.json(),
              })),
            ),
          );
          return { id: doc.id, keys: started.map((one) => one.key), done };
        },
        { dest: who.dest, bytes: await pdf("doble") },
      );
      assert.deepEqual(
        result.done.map((answer) => answer.status),
        [200, 200],
      );
      const kept = result.done.map((answer) => answer.body.doc.file.key);
      assert.equal(kept[0], kept[1], "both answers name the same stored file");
      const rows = await query(
        `select file_key from vault_doc where user_id = $1 and portfolio_id = $2 and not deleted`,
        [who.userId, who.dest],
      );
      assert.equal(rows.length, 1, "one document");
      assert.equal(rows[0].file_key, kept[0]);
      // The other object is gone from storage: reading it through the API finds nothing.
      const other = result.keys.find((key) => key !== kept[0]);
      const blob = await query(`select 1 from vault_doc where file_key = $1`, [other]);
      assert.equal(blob.length, 0);
      await context.close();
    });

    test("T08b the antivirus overloaded (503): one file at a time, that file sent again, no duplicate", async () => {
      const who = await fresh();
      const { context, page } = await signIn(browser, who);
      let inFlight = 0;
      let after503 = 0;
      let refused = false;
      await page.route("**/api/files/uploads/complete", async (route) => {
        const body = route.request().postDataJSON();
        if (body?.abort) return route.continue();
        if (!refused) {
          // The first completion answers as an overloaded antivirus would, without storing it.
          refused = true;
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "El antivirus no terminó de analizar a tiempo." }),
          });
        }
        inFlight += 1;
        after503 = Math.max(after503, inFlight);
        const response = await route.fetch();
        inFlight -= 1;
        return route.fulfill({ response });
      });
      await dropTree(page, who.dest, { Lento: { folder: await pdfs(9, "l") } });
      assert.match(await jobEnds(page), /Archivos subidos\s*9/);
      const server = await serverTree(who.userId, who.dest);
      assert.equal(server.files.length, 9);
      assert.equal(new Set(server.files).size, 9);
      assert.ok(
        after503 <= 2,
        `at most the file already sent overlaps after the 503 (${after503})`,
      );
      await page.unroute("**/api/files/uploads/complete");
      await context.close();
    });
  });
}
