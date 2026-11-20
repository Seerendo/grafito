import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

/** Deletions made in the browser that the server has not confirmed yet. */

const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
});

const {
  confirmDeletes,
  dropDeletes,
  markDeletesFailed,
  onPendingDeletes,
  pendingDeletes,
  recordDeletes,
} = await import("../../../src/app/vault/pending-deletes.ts");

let user = 0;
let id = "";
beforeEach(() => {
  user += 1;
  id = `u${user}`;
});

test("se guardan aparte de la copia de la bóveda", () => {
  recordDeletes(id, ["d1", "d2"], ["p1"]);
  assert.deepEqual(Object.keys(pendingDeletes(id).docs), ["d1", "d2"]);
  const saved = JSON.parse(stored.get(`grafito.deletes:${id}`) ?? "{}");
  assert.deepEqual(Object.keys(saved.docs), ["d1", "d2"]);
  assert.deepEqual(Object.keys(saved.portfolios), ["p1"]);
});

test("al confirmarse se olvidan; lo demás sigue pendiente", () => {
  recordDeletes(id, ["d1", "d2"], ["p1"]);
  markDeletesFailed(id, true);
  assert.equal(pendingDeletes(id).failed, true);
  confirmDeletes(id, { docs: ["d1"], portfolios: ["p1"] });
  const left = pendingDeletes(id);
  assert.deepEqual(Object.keys(left.docs), ["d2"]);
  assert.deepEqual(Object.keys(left.portfolios), []);
  assert.equal(left.failed, false);
  confirmDeletes(id, { docs: ["d2"], portfolios: [] });
  assert.equal(stored.has(`grafito.deletes:${id}`), false);
});

test("lo que vuelve (restaurado) deja de estar pendiente", () => {
  recordDeletes(id, ["d1"], ["p1"]);
  dropDeletes(id, ["d1"], ["p1"]);
  assert.deepEqual(pendingDeletes(id), { docs: {}, portfolios: {}, failed: false });
});

test("se conserva la hora del primer borrado y los cambios avisan", () => {
  let calls = 0;
  const stop = onPendingDeletes(() => {
    calls += 1;
  });
  recordDeletes(id, ["d1"]);
  const first = pendingDeletes(id).docs.d1;
  recordDeletes(id, ["d1"]);
  assert.equal(pendingDeletes(id).docs.d1, first);
  assert.ok(calls >= 2);
  stop();
});

test("sin usuario no se registra nada", () => {
  recordDeletes(null, ["d1"]);
  assert.equal(stored.has("grafito.deletes:null"), false);
});
