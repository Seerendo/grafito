/**
 * PDF signature rectangles in real browser engines (Chromium, Firefox, WebKit) against a running
 * Grafito dev server on the local test stack. Not part of `npm test`: it needs the stack, a dev
 * server and Playwright, which is not a project dependency.
 *
 *   E2E_BASE_URL=http://127.0.0.1:3200 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_BROWSERS=chromium,firefox,webkit,chrome \
 *   node --test tests/e2e/pdf-signatures.e2e.mjs
 *
 * The dev server must use the test stack's Postgres and MinIO (see signature-seed.mjs).
 * Each browser reseeds the "e2esig-" rows, so runs are repeatable.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { deflateSync, crc32 } from "node:zlib";
import pg from "pg";
import { PASSWORD, seed } from "./signature-seed.mjs";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:3200").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const engines = (process.env.E2E_BROWSERS ?? "chromium,firefox,webkit").split(",");
const WAIT = 90_000;
/** Geometry tolerance as a fraction of the page: about 2 px on an 800 px page. */
const TOLERANCE = 0.004;

const SIGNER = "e2esig-signer";
const OWNER = "e2esig-owner";
const OUTSIDER = "e2esig-outsider";

/** The rectangle the owner draws for the signer in the first test, as fractions of page 3. */
const DRAWN = { page: 3, x: 0.55, y: 0.6, w: 0.3, h: 0.1 };

function database() {
  return new pg.Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:5432/grafito",
  });
}

/** A small opaque PNG to sign with. */
function signaturePng() {
  const width = 60;
  const height = 24;
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const ink = Math.abs(y - height / 2 - Math.sin(x / 6) * 6) < 2 ? 20 : 255;
      raw[at] = ink;
      raw[at + 1] = ink;
      raw[at + 2] = ink === 255 ? 255 : 120;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Sign in the way the app does (password sign-in, bearer token in localStorage). Without
 * cookies the session lives only in that token, as on a plain-HTTP address other than
 * localhost, where browsers refuse the Secure __Host- cookies.
 */
async function signIn(browser, login, { cookies = true, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  await page.goto(`${base}/login`);
  const status = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const token = response.headers.get("set-auth-token");
      if (token) localStorage.setItem("grafito-auth.bearer-token", token);
      return response.status;
    },
    { email: `${login}@grafito.app`, password: PASSWORD },
  );
  assert.equal(status, 200, `sign-in ${login}`);
  if (!cookies) await context.clearCookies();
  return { context, page };
}

/** Wait until the signature state settled and page 1 of the PDF is laid out. */
async function pdfReady(page, state = "ready") {
  await page.locator(`[data-ui="pdf-signatures"][data-state="${state}"]`).waitFor();
  await page.locator('div[data-page="1"]:not([data-text-layer]) canvas').waitFor();
}

/**
 * Every signature rectangle with its page, status, label, buttons and position relative to its
 * page. Each one is scrolled into view and hit-tested at its centre, so a box hidden under
 * another layer counts as not visible (signed boxes let clicks through and are not hit-tested).
 */
async function boxes(page) {
  const count = await page.locator('[data-ui="pdf-sign"]').count();
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const box = page.locator('[data-ui="pdf-sign"]').nth(index);
    await box.scrollIntoViewIfNeeded();
    // Let the scroll settle before measuring.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
    out.push(
      await box.evaluate((element) => {
        const host = element.closest("div[data-page]:not([data-text-layer])");
        const rect = element.getBoundingClientRect();
        const frame = host.getBoundingClientRect();
        const style = getComputedStyle(element);
        const centre = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          page: Number(host.dataset.page),
          status: element.dataset.status,
          label: element.querySelector("span")?.textContent ?? "",
          buttons: [...element.querySelectorAll("button")].map((button) => button.textContent),
          x: (rect.left - frame.left) / frame.width,
          y: (rect.top - frame.top) / frame.height,
          w: rect.width / frame.width,
          h: rect.height / frame.height,
          pixels: { width: rect.width, height: rect.height },
          shown: style.visibility !== "hidden" && style.display !== "none" && rect.width > 4,
          onTop:
            element.dataset.status === "signed" ||
            Boolean(centre && (element === centre || element.contains(centre))),
        };
      }),
    );
  }
  return out;
}

/** The seeded rectangles plus the one the owner draws, as each viewer should see them. */
function expected(boxRows, { drawn = true } = {}) {
  const rows = boxRows.map(([id, , signer, status, page, x, y, w, h]) => ({
    id,
    signer,
    status,
    page,
    x,
    y,
    w,
    h,
  }));
  if (drawn) rows.push({ id: "drawn", signer: SIGNER, status: "pending", ...DRAWN });
  return rows;
}

function sameGeometry(actual, want, tolerance = TOLERANCE) {
  return ["x", "y", "w", "h"].every((key) => Math.abs(actual[key] - want[key]) <= tolerance);
}

/** Each wanted rectangle is present once, visible, on top, at its place on its page. */
function assertBoxes(actual, wanted, viewer, tolerance = TOLERANCE) {
  assert.equal(actual.length, wanted.length, `${viewer}: number of rectangles`);
  const left = [...actual];
  for (const want of wanted) {
    const near = want.id === "drawn" ? 0.02 : tolerance;
    const at = left.findIndex(
      (box) =>
        box.page === want.page && box.status === want.status && sameGeometry(box, want, near),
    );
    assert.ok(
      at >= 0,
      `${viewer}: missing ${want.status} rectangle on page ${want.page} at ${want.x},${want.y}; got ${JSON.stringify(actual)}`,
    );
    const [box] = left.splice(at, 1);
    assert.ok(box.shown, `${viewer}: rectangle ${want.id} is not visible`);
    assert.ok(box.onTop, `${viewer}: rectangle ${want.id} is covered by another layer`);
    assert.ok(box.pixels.width > 20 && box.pixels.height > 10, `${viewer}: ${want.id} too small`);
    const mine = want.signer === viewer && want.status === "pending";
    assert.equal(
      box.buttons.includes("Firmar"),
      mine,
      `${viewer}: "Firmar" on ${want.id} only for its pending signer`,
    );
    if (want.status === "declined") assert.match(box.label, /Rechazada/);
    if (want.status === "pending") assert.match(box.label, /Pendiente/);
  }
}

/** Open a document listed in the vault sidebar's "Compartidos conmigo". */
async function openFromSidebar(page, title) {
  const sidebar = page.locator("aside, nav").filter({ hasText: "Compartidos conmigo" }).first();
  const entry = sidebar.getByText(title, { exact: true }).first();
  if (!(await entry.isVisible().catch(() => false)))
    await sidebar.getByText("Compartidos conmigo", { exact: true }).first().click();
  await entry.click();
}

/** Fail only the signatureState server function (its dev id names the export). */
function isSignatureState(url) {
  const id = new URL(url).pathname.split("/_serverFn/")[1];
  if (!id) return false;
  try {
    return Buffer.from(id, "base64url").toString("utf8").includes('"export":"signatureState_');
  } catch {
    return false;
  }
}

for (const engine of engines) {
  describe(`firmas PDF en ${engine}`, { concurrency: false }, () => {
    let browser;
    let data;
    let wanted;
    const opened = [];
    const track = (session) => {
      opened.push(session.context);
      return session;
    };

    before(async () => {
      data = await seed();
      wanted = expected(data.boxes, { drawn: false });
      // "chrome" is the installed Google Chrome; the others are Playwright's own engines.
      browser =
        engine === "chrome"
          ? await playwright.chromium.launch({ channel: "chrome" })
          : await playwright[engine].launch();
    });

    after(async () => {
      for (const context of opened) await context.close().catch(() => undefined);
      await browser?.close();
    });

    test("el propietario dibuja un recuadro y elige a quién firma", async () => {
      const { page } = track(await signIn(browser, OWNER));
      await page.goto(`${base}/`);
      await page.getByText("Contrato e2e", { exact: true }).first().click();
      await pdfReady(page);
      assertBoxes(await boxes(page), expected(data.boxes, { drawn: false }), OWNER);
      await page.getByRole("button", { name: "Añadir espacio de firma" }).click();
      const target = page.locator(`div[data-page="${DRAWN.page}"]:not([data-text-layer])`);
      await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
      // Pages take their own size once PDF.js renders them (page 3 is Letter, not A4).
      await target.locator("canvas").evaluate(
        (canvas) =>
          new Promise((done) => {
            const check = () => (canvas.height > 150 ? done(null) : requestAnimationFrame(check));
            check();
          }),
      );
      await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
      const frame = await target.boundingBox();
      const point = (fx, fy) => [frame.x + frame.width * fx, frame.y + frame.height * fy];
      await page.mouse.move(...point(DRAWN.x, DRAWN.y));
      await page.mouse.down();
      await page.mouse.move(...point(DRAWN.x + DRAWN.w / 2, DRAWN.y + DRAWN.h / 2), { steps: 4 });
      await page.mouse.move(...point(DRAWN.x + DRAWN.w, DRAWN.y + DRAWN.h), { steps: 4 });
      await page.mouse.up();
      await page.getByRole("radio", { name: new RegExp(SIGNER) }).click();
      await page.getByRole("button", { name: "Asignar" }).click();
      await page.locator('[data-ui="pdf-sign"]').nth(data.boxes.length).waitFor();
      wanted = expected(data.boxes);
      assertBoxes(await boxes(page), wanted, OWNER);
    });

    test("la persona invitada lo ve desde su lista de firmas pendientes", async () => {
      const { page } = track(await signIn(browser, SIGNER, { cookies: false }));
      await page.goto(`${base}/`);
      await page.getByText("Carpeta Personal", { exact: true }).first().click();
      const list = page.locator("section").filter({ hasText: "Firmas pendientes" });
      await list.getByText("Contrato e2e").first().click();
      await pdfReady(page);
      assertBoxes(await boxes(page), wanted, SIGNER);

      // Another document and back again.
      await openFromSidebar(page, "Otra nota e2e");
      await page.locator('[data-ui="pdf-signatures"]').waitFor({ state: "detached" });
      await openFromSidebar(page, "Contrato e2e");
      await pdfReady(page);
      assertBoxes(await boxes(page), wanted, SIGNER);
    });

    test("por enlace directo, tras recargar y en una sesión nueva", async () => {
      const first = track(await signIn(browser, SIGNER));
      await first.page.goto(`${base}/compartidos/${data.shareId}`);
      await pdfReady(first.page);
      assertBoxes(await boxes(first.page), wanted, SIGNER);
      await first.page.reload();
      await pdfReady(first.page);
      assertBoxes(await boxes(first.page), wanted, SIGNER);

      // A second session of the same person, only with the bearer token, while the first is open.
      const second = track(await signIn(browser, SIGNER, { cookies: false }));
      await second.page.goto(`${base}/compartidos/${data.shareId}`);
      await pdfReady(second.page);
      assertBoxes(await boxes(second.page), wanted, SIGNER);
    });

    test("un fallo de red se ve como error y se recupera al reintentar", async () => {
      const { page } = track(await signIn(browser, SIGNER));
      let blocked = true;
      await page.route(
        (url) => isSignatureState(url.href),
        (route) => (blocked ? route.abort("failed") : route.continue()),
      );
      await page.goto(`${base}/compartidos/${data.shareId}`);
      await pdfReady(page, "error");
      await page.getByText("No se pudieron leer las firmas.").first().waitFor();
      assert.equal(await page.locator('[data-ui="pdf-sign"]').count(), 0);
      blocked = false;
      await page.getByRole("button", { name: "Reintentar" }).click();
      await pdfReady(page);
      assertBoxes(await boxes(page), wanted, SIGNER);
    });

    test("al redimensionar y con otra densidad de píxeles siguen en su sitio", async () => {
      const { page } = track(await signIn(browser, SIGNER));
      await page.goto(`${base}/compartidos/${data.shareId}`);
      await pdfReady(page);
      for (const size of [
        { width: 1600, height: 1000 },
        { width: 820, height: 900 },
        { width: 390, height: 844 },
      ]) {
        const before = await page
          .locator('div[data-page="1"]:not([data-text-layer])')
          .boundingBox();
        await page.setViewportSize(size);
        await page.waitForFunction(
          (width) =>
            document
              .querySelector('div[data-page="1"]:not([data-text-layer])')
              ?.getBoundingClientRect().width !== width,
          before.width,
        );
        await page.locator('div[data-page="1"]:not([data-text-layer]) canvas').waitFor();
        assertBoxes(await boxes(page), wanted, SIGNER);
      }
      for (const deviceScaleFactor of [1.25, 2]) {
        const dense = track(await signIn(browser, SIGNER, { deviceScaleFactor }));
        await dense.page.goto(`${base}/compartidos/${data.shareId}`);
        await pdfReady(dense.page);
        assertBoxes(await boxes(dense.page), wanted, SIGNER);
      }
    });

    test("quien no tiene acceso no ve los recuadros ni puede firmar", async () => {
      const { page } = track(await signIn(browser, OUTSIDER));
      await page.goto(`${base}/compartidos/${data.shareId}`);
      await page.getByText("No existe o ya no está compartido contigo.").waitFor();
      assert.equal(await page.locator('[data-ui="pdf-sign"]').count(), 0);
      // The same server functions the viewer uses, called directly with the outsider's session.
      const answers = await page.evaluate(
        async ({ docId, shareId }) => {
          const api = await import("/src/server/signature.functions.ts");
          return {
            state: await api.signatureState({ data: { docId, shareId } }),
            own: await api.signatureState({ data: { docId } }),
            sign: await api.answerSignature({ data: { id: "e2esig-pending-3", status: "signed" } }),
            decline: await api.answerSignature({
              data: { id: "e2esig-pending-3", status: "declined" },
            }),
          };
        },
        { docId: data.docId, shareId: data.shareId },
      );
      assert.equal(answers.state.ok, false);
      assert.deepEqual(answers.state.rows, []);
      assert.equal(answers.own.ok, false);
      assert.equal(answers.sign.ok, false);
      assert.equal(answers.decline.ok, false);
    });

    test("firmar y rechazar cambian el estado de cada recuadro", async () => {
      // The owner declines their own request on page 1.
      const owner = track(await signIn(browser, OWNER));
      await owner.page.goto(`${base}/`);
      await owner.page.getByText("Contrato e2e", { exact: true }).first().click();
      await pdfReady(owner.page);
      const ownBox = owner.page.locator(
        'div[data-page="1"]:not([data-text-layer]) [data-ui="pdf-sign"][data-status="pending"]',
      );
      await ownBox.scrollIntoViewIfNeeded();
      await ownBox.getByRole("button", { name: "Rechazar" }).click();
      await owner.page
        .locator(
          'div[data-page="1"]:not([data-text-layer]) [data-ui="pdf-sign"][data-status="declined"]',
        )
        .waitFor();

      // The signer signs the rectangle drawn for them on page 3 with an image.
      const { page } = track(await signIn(browser, SIGNER));
      await page.goto(`${base}/compartidos/${data.shareId}`);
      await pdfReady(page);
      const mine = page.locator(
        'div[data-page="3"]:not([data-text-layer]) [data-ui="pdf-sign"][data-status="pending"]',
      );
      await mine.scrollIntoViewIfNeeded();
      const chooser = page.waitForEvent("filechooser");
      await mine.getByRole("button", { name: "Firmar" }).click();
      await (
        await chooser
      ).setFiles({ name: "firma.png", mimeType: "image/png", buffer: signaturePng() });
      await page
        .locator(
          'div[data-page="3"]:not([data-text-layer]) [data-ui="pdf-sign"][data-status="signed"]',
        )
        .waitFor();
      await pdfReady(page);
      const now = wanted.map((box) =>
        box.id === "e2esig-owner-box"
          ? { ...box, status: "declined" }
          : box.id === "drawn"
            ? { ...box, status: "signed" }
            : box,
      );
      assertBoxes(await boxes(page), now, SIGNER);
      wanted = now;
    });

    test("si se retira el acceso, deja de ver los recuadros y lo dice", async () => {
      const { page } = track(await signIn(browser, SIGNER));
      await page.goto(`${base}/compartidos/${data.shareId}`);
      await pdfReady(page);
      assertBoxes(await boxes(page), wanted, SIGNER);
      const client = database();
      await client.connect();
      try {
        await client.query(`delete from share_grant where share_id = $1`, [data.shareId]);
      } finally {
        await client.end();
      }
      // Opening the signature list asks the server again.
      await page
        .locator('[data-ui="pdf-signatures"]')
        .getByRole("button", { name: "Firmas" })
        .click();
      await pdfReady(page, "denied");
      await page.getByText("Sin acceso a las firmas de este documento.").first().waitFor();
      assert.equal(await page.locator('[data-ui="pdf-sign"]').count(), 0);
    });
  });
}
