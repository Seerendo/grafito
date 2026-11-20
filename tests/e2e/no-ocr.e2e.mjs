/**
 * Grafito without OCR (T22–T27) against the local test stack (project grafito-e2e): no OCR
 * service, table or extension; a digital PDF is indexed and found by its words; a scanned PDF and
 * a photo are stored, shown and downloaded, and found by name only; indexing finishes with no
 * OCR. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:8080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_COMPOSE="docker compose -p grafito-e2e -f docker-compose.test.yml" \
 *   node --test tests/e2e/no-ocr.e2e.mjs
 *
 * Each run creates a fresh "e2eno-" member.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  dropTree,
  engines,
  fetchOwnFile,
  jobEnds,
  member,
  pdf,
  playwright,
  query,
  signIn,
  until,
} from "./vault-harness.mjs";

const COMPOSE =
  process.env.E2E_COMPOSE ?? "docker compose -p grafito-e2e -f docker-compose.test.yml";

async function openByTitle(page, title) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(title);
  await page
    .getByRole("option", { name: new RegExp(title) })
    .first()
    .click();
}

/** Search from the command palette and wait for a result with that title. */
async function found(page, words, title) {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(words);
  await page
    .getByRole("option", { name: new RegExp(title) })
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
}

for (const engine of engines) {
  describe(`no OCR (${engine})`, () => {
    let browser;
    let started;
    before(async () => {
      started = new Date();
      browser = await playwright[engine].launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("T22 the stack runs without an OCR service, table or extension", async () => {
      const services = execSync(`${COMPOSE} config --services`, { encoding: "utf8" });
      assert.ok(!services.split(/\s+/).includes("ocr"), "no ocr service in the compose file");
      const running = execSync(`${COMPOSE} ps --format "{{.Service}}"`, { encoding: "utf8" });
      assert.ok(!running.split(/\s+/).includes("ocr"), "no ocr container");
      assert.equal((await query(`select to_regclass('ocr_text') as t`))[0].t, null);
      assert.equal((await query(`select 1 from app_plugin where id = 'ocr'`)).length, 0);
      assert.equal(
        (await query(`select 1 from _migrations where name = '0045_remove_ocr.sql'`)).length,
        1,
      );
    });

    test("T23–T27 digital PDF by its words; scanned PDF and photo stored, shown, found by name", async () => {
      const who = await member("e2eno");
      const { context, page } = await signIn(browser, who);
      // A "scan": text drawn on a canvas, as a PNG photo and as an image-only PDF.
      const art = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1240;
        canvas.height = 1754;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#111";
        ctx.font = "56px serif";
        ctx.fillText("Expediente hipopotamo numero 4521", 120, 380);
        const encode = async (type) => {
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = "";
          for (const byte of bytes) text += String.fromCharCode(byte);
          return btoa(text);
        };
        return { png: await encode("image/png"), jpeg: await encode("image/jpeg") };
      });
      const scan = await PDFDocument.create();
      const image = await scan.embedJpg(Buffer.from(art.jpeg, "base64"));
      scan.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
      const scanned = Buffer.from(await scan.save()).toString("base64");
      await dropTree(page, who.dest, {
        "digital-ornitorrinco.pdf": {
          file: [0, await pdf("Informe del ornitorrinco azul"), "application/pdf"],
        },
        "escaneo-contrato.pdf": { file: [0, scanned, "application/pdf"] },
        "foto-contrato.png": { file: [0, art.png, "image/png"] },
      });
      assert.match(await jobEnds(page), /Archivos subidos\s*3/);
      const docs = Object.fromEntries(
        (
          await query(
            `select id, file_name from vault_doc where user_id = $1 and not deleted and kind = 'file'`,
            [who.userId],
          )
        ).map((row) => [row.file_name, row.id]),
      );

      // T26: every one is indexed, with no OCR anywhere.
      await until(async () => {
        const rows = await query(
          `select c.ok from content_index c join vault_doc d on d.user_id = c.user_id and d.id = c.doc_id
           where c.user_id = $1 and c.rev = d.rev`,
          [who.userId],
        );
        return rows.length === 3 && rows.every((row) => row.ok);
      }, "indexed");
      const logs = execSync(`${COMPOSE} logs app --since ${started.toISOString()}`, {
        encoding: "utf8",
      });
      assert.ok(!/\[ocr\]|ocr:8080/i.test(logs), "no OCR call in the app's log");

      // T23/T27: the digital PDF is found by a word inside it.
      const body = async (name) =>
        (
          await query(`select body from doc_index where user_id = $1 and doc_id = $2`, [
            who.userId,
            docs[name],
          ])
        )[0]?.body ?? "";
      assert.match(await body("digital-ornitorrinco.pdf"), /ornitorrinco azul/i);
      await found(page, "ornitorrinco azul", "digital-ornitorrinco");

      // T24/T25/T27: the scan and the photo carry their name only, and no recognized text.
      for (const name of ["escaneo-contrato.pdf", "foto-contrato.png"]) {
        const text = await body(name);
        assert.ok(!/hipopotamo/i.test(text), `${name} has no recognized text`);
        assert.match(text, new RegExp(name.split(".")[0]));
      }
      await found(page, "escaneo-contrato", "escaneo-contrato");

      // T24: the scanned PDF opens and downloads.
      await openByTitle(page, "escaneo-contrato");
      await page.locator('[data-ui="pdf"] canvas').first().waitFor();
      const pdfRead = await fetchOwnFile(page, docs["escaneo-contrato.pdf"], true);
      assert.equal(pdfRead.status, 200);
      assert.equal(pdfRead.head, "%PDF-");
      assert.match(pdfRead.disposition ?? "", /attachment/);

      // T25: the photo shows and downloads.
      await openByTitle(page, "foto-contrato");
      const img = page.locator('img[alt="foto-contrato"]');
      await img.waitFor();
      await until(async () => (await img.evaluate((node) => node.naturalWidth)) > 0, "photo shown");
      const pngRead = await fetchOwnFile(page, docs["foto-contrato.png"]);
      assert.equal(pngRead.status, 200);
      assert.equal(pngRead.type, "image/png");
      await context.close();
    });
  });
}
