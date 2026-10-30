import assert from "node:assert/strict";
import { test } from "node:test";
import { placePopup } from "./popup.ts";

const view = { viewLeft: 0, viewTop: 0, viewWidth: 400, viewHeight: 300, margin: 8 };

test("la nota se apoya a la izquierda cuando cabe", () => {
  const box = placePopup({ ...view, x: 320, y: 40, width: 200, height: 80, prefer: "left" });
  assert.deepEqual(box, { left: 120, top: 40 });
});

test("junto al borde izquierdo, la nota pasa al otro lado y no se esconde", () => {
  const box = placePopup({ ...view, x: 16, y: 40, width: 288, height: 80, prefer: "left" });
  assert.ok(box.left >= 8);
  assert.ok(box.left + 288 <= 392);
  assert.ok(box.left >= 16);
});

test("la burbuja centrada en el borde se mete en el marco", () => {
  const box = placePopup({ ...view, x: 4, y: 40, width: 288, height: 80, prefer: "center" });
  assert.equal(box.left, 8);
  assert.ok(box.left + 288 <= 392);
});

test("junto al borde de abajo, la nota sube", () => {
  const box = placePopup({ ...view, x: 200, y: 280, width: 100, height: 80, prefer: "center" });
  assert.equal(box.top, 200);
  assert.ok(box.top >= 8);
  assert.ok(box.top + 80 <= 292);
});
