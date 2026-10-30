import assert from "node:assert/strict";
import { test } from "node:test";
import { boxToPdf, isPdfFile, validBox, type SignatureBox } from "./signature-box.ts";

const box: SignatureBox = { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 };

test("un PDF se reconoce por el tipo o por el nombre", () => {
  assert.equal(isPdfFile("acta.PDF", "application/octet-stream"), true);
  assert.equal(isPdfFile("acta.bin", "application/pdf"), true);
  assert.equal(isPdfFile("acta.png", "image/png"), false);
});

test("el recuadro tiene que caber en una página", () => {
  assert.equal(validBox(box, 2), true);
  assert.equal(validBox({ ...box, page: 0 }, 2), false);
  assert.equal(validBox({ ...box, page: 3 }, 2), false);
  assert.equal(validBox({ ...box, w: 0.01 }, 2), false);
  assert.equal(validBox({ ...box, x: 0.8 }, 2), false);
});

test("sin giro, el origen de arriba pasa a abajo", () => {
  assert.deepEqual(boxToPdf(box, 100, 200, 0), { x: 10, y: 80, width: 30, height: 80 });
});

test("un giro de 180 da la vuelta al recuadro", () => {
  assert.deepEqual(boxToPdf(box, 100, 200, 180), { x: 60, y: 40, width: 30, height: 80 });
});

test("un giro de 90 intercambia los ejes de la página", () => {
  assert.deepEqual(boxToPdf({ page: 1, x: 0, y: 0, w: 0.5, h: 0.25 }, 200, 100, 90), {
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  });
});
