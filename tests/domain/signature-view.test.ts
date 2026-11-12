import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIGNATURES_LOADING,
  failSignatures,
  settleSignatures,
  signatureBoxes,
  signatureKey,
  signedMark,
  type SignatureViewRow,
} from "../../src/domain/signature-view.ts";

/** PDF signature requests as the viewer shows them: states and rectangles. */

function row(patch: Partial<SignatureViewRow> = {}): SignatureViewRow {
  return {
    id: "a",
    signerName: "Ana",
    status: "pending",
    requestedByName: "Beto",
    requestedAt: 1,
    decidedAt: null,
    note: "",
    stale: false,
    mine: true,
    page: 1,
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.1,
    ...patch,
  };
}

test("la clave separa el mismo documento visto desde la bóveda y desde un compartido", () => {
  assert.notEqual(signatureKey("doc"), signatureKey("doc", "share"));
  assert.equal(signatureKey("doc", undefined), signatureKey("doc", null));
});

test("una respuesta con acceso queda lista, también sin firmas", () => {
  assert.deepEqual(settleSignatures({ ok: true, canRequest: true, rows: [] }), {
    status: "ready",
    rows: [],
    canRequest: true,
  });
  const rows = [row()];
  assert.equal(settleSignatures({ ok: true, canRequest: false, rows }).rows, rows);
});

test("acceso denegado no es lo mismo que no tener firmas", () => {
  const load = settleSignatures({ ok: false, canRequest: true, rows: [] });
  assert.equal(load.status, "denied");
  assert.equal(load.canRequest, false);
  assert.deepEqual(load.rows, []);
});

test("un fallo de red conserva los recuadros que ya se veían", () => {
  const ready = settleSignatures({ ok: true, canRequest: true, rows: [row()] });
  const failed = failSignatures(ready);
  assert.equal(failed.status, "error");
  assert.equal(failed.rows.length, 1);
  assert.equal(failed.canRequest, true);
  assert.deepEqual(failSignatures(undefined), { status: "error", rows: [], canRequest: false });
  assert.equal(failSignatures(SIGNATURES_LOADING).rows.length, 0);
});

test("los recuadros conservan su página, su posición y su estado", () => {
  const boxes = signatureBoxes([
    row({ id: "p", page: 1 }),
    row({ id: "s", page: 3, status: "signed", mine: false }),
    row({ id: "d", page: 2, status: "declined" }),
  ]);
  assert.deepEqual(
    boxes.map((box) => [box.id, box.page, box.status]),
    [
      ["p", 1, "pending"],
      ["s", 3, "signed"],
      ["d", 2, "declined"],
    ],
  );
  assert.deepEqual(
    { x: boxes[0]!.x, y: boxes[0]!.y, w: boxes[0]!.w, h: boxes[0]!.h },
    { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
  );
});

test("sin página o geometría no hay recuadro que dibujar", () => {
  assert.equal(signatureBoxes([row({ page: null })]).length, 0);
  assert.equal(signatureBoxes([row({ x: null })]).length, 0);
  assert.equal(signatureBoxes([row({ page: 0 })]).length, 0);
  assert.equal(signatureBoxes([row({ page: 1.5 })]).length, 0);
  assert.equal(signatureBoxes([row({ w: 0 })]).length, 0);
  assert.equal(signatureBoxes([row({ h: Number.NaN })]).length, 0);
});

test("un recuadro que se sale por redondeo queda dentro de la página", () => {
  const [box] = signatureBoxes([row({ x: 0.8, y: -0.01, w: 0.3, h: 0.2 })]);
  assert.equal(box!.x, 0.8);
  assert.equal(box!.y, 0);
  assert.ok(Math.abs(box!.w - 0.2) < 1e-9);
  assert.equal(signatureBoxes([row({ x: 1, w: 0.2 })]).length, 0);
});

test("la marca de firmadas cambia solo cuando alguien firma", () => {
  const before = signedMark([row({ id: "b", status: "signed" }), row({ id: "a" })]);
  const same = signedMark([row({ id: "a" }), row({ id: "b", status: "signed" })]);
  const after = signedMark([
    row({ id: "a", status: "signed" }),
    row({ id: "b", status: "signed" }),
  ]);
  assert.equal(before, same);
  assert.notEqual(before, after);
});
