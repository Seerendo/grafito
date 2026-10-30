import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { decodeSignatureImage, imageKind, stampSignature } from "./signature-stamp.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("una firma PNG se estampa y el PDF sigue teniendo su página", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  const original = await pdf.save();
  const stamped = await stampSignature(original, new Uint8Array(PNG), { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  const again = await PDFDocument.load(stamped);
  assert.equal(again.getPageCount(), 1);
  assert.notEqual(Buffer.from(stamped).toString("base64"), Buffer.from(original).toString("base64"));
  assert.equal(imageKind(new Uint8Array(PNG)), "png");
});

test("lo que no es una imagen no se estampa", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  await assert.rejects(
    () => stampSignature(bytes, new Uint8Array([1, 2, 3, 4]), { page: 1, x: 0, y: 0, w: 0.2, h: 0.2 }),
    /PNG o JPEG/,
  );
});

test("una imagen enorme no se acepta", () => {
  assert.equal(decodeSignatureImage("a".repeat(700_001)), "big");
  assert.equal(decodeSignatureImage(""), null);
});
