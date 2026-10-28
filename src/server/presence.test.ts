import assert from "node:assert/strict";
import { test } from "node:test";
import { TTL_MS, touchPresence } from "./presence.ts";

/** Quién está editando una nota. */

const note = { ownerId: "dueña", docId: "nota-1" };

test("cada una ve a las demás, no a sí misma", () => {
  assert.deepEqual(touchPresence({ ...note, userId: "ana", name: "Ana", editing: true }, 1000), []);
  assert.deepEqual(touchPresence({ ...note, userId: "luis", name: "Luis", editing: true }, 2000), ["Ana"]);
  assert.deepEqual(touchPresence({ ...note, userId: "ana", name: "Ana", editing: true }, 3000), ["Luis"]);
});

test("al dejar de editar desaparece", () => {
  touchPresence({ ...note, userId: "ana", name: "Ana", editing: false }, 4000);
  assert.deepEqual(touchPresence({ ...note, userId: "luis", name: "Luis", editing: true }, 5000), []);
});

test("quien deja de avisar caduca", () => {
  const other = { ownerId: "dueña", docId: "nota-2" };
  touchPresence({ ...other, userId: "ana", name: "Ana", editing: true }, 10_000);
  assert.deepEqual(touchPresence({ ...other, userId: "luis", name: "Luis", editing: true }, 10_000 + TTL_MS - 1), ["Ana"]);
  assert.deepEqual(touchPresence({ ...other, userId: "luis", name: "Luis", editing: true }, 10_000 + TTL_MS + 1), []);
});

test("cada nota tiene su lista", () => {
  touchPresence({ ownerId: "dueña", docId: "nota-3", userId: "ana", name: "Ana", editing: true }, 1);
  assert.deepEqual(touchPresence({ ownerId: "otra", docId: "nota-3", userId: "luis", name: "Luis", editing: true }, 2), []);
});
