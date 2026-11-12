import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_SLICE, readSlice } from "../../src/domain/ai-read.ts";

/** The assistant receives a window of a document, not the whole file. */

test("el primer tramo cabe en el límite y avisa si queda texto", () => {
  const text = "a".repeat(READ_SLICE + 25);
  const slice = readSlice(text, 0);
  assert.equal(slice.content.length, READ_SLICE);
  assert.equal(slice.offset, 0);
  assert.equal(slice.length, text.length);
  assert.equal(slice.truncated, true);
});

test("offset continúa donde terminó el tramo anterior", () => {
  const text = "abcdefghijklmnopqrstuvwxyz";
  const slice = readSlice(text, 4, 3);
  assert.deepEqual(slice, { content: "efg", offset: 4, length: 26, truncated: true });
  const rest = readSlice(text, 4 + 3, 30);
  assert.equal(rest.content, "hijklmnopqrstuvwxyz");
  assert.equal(rest.truncated, false);
});

test("un offset pasado del final no inventa texto", () => {
  const slice = readSlice("hola", 99);
  assert.equal(slice.content, "");
  assert.equal(slice.offset, 4);
  assert.equal(slice.truncated, false);
});
