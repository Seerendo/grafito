import assert from "node:assert/strict";
import { test } from "node:test";
import { keepSigners } from "./signature-people.ts";

test("firman el dueño, quien lo pide y solo con quien se compartió", () => {
  const ids = keepSigners({
    ownerId: "dueño",
    callerId: "dueño",
    grantedIds: ["ana", "ana", "luis"],
    hiddenIds: new Set(["ws-interno"]),
  });
  assert.deepEqual(ids, ["dueño", "ana", "luis"]);
});

test("la cuenta interna del espacio no aparece, aunque sea el dueño", () => {
  const ids = keepSigners({
    ownerId: "ws-interno",
    callerId: "admin",
    grantedIds: ["admin", "ws-interno", "miembro"],
    hiddenIds: new Set(["ws-interno"]),
  });
  assert.deepEqual(ids, ["admin", "miembro"]);
});
