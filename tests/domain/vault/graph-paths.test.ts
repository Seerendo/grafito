import assert from "node:assert/strict";
import { test } from "node:test";
import { neighbourhood, shortestPath } from "../../../src/domain/vault/graph.ts";

/** Entorno by levels and the path between two documents, links taken in either direction. */

// a → b → c → d, and e ← c; f is apart.
const edges = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
  { from: "c", to: "d" },
  { from: "e", to: "c" },
  { from: "f", to: "f" },
];

test("el entorno crece por niveles y sigue vínculos en ambas direcciones", () => {
  assert.deepEqual([...neighbourhood(edges, "b", 1)].sort(), ["a", "b", "c"]);
  assert.deepEqual([...neighbourhood(edges, "b", 2)].sort(), ["a", "b", "c", "d", "e"]);
  assert.deepEqual([...neighbourhood(edges, "f", 3)], ["f"]);
  assert.deepEqual([...neighbourhood(edges, "x", 2)], ["x"]);
});

test("el camino más corto entre dos notas, o ninguno", () => {
  assert.deepEqual(shortestPath(edges, "a", "d"), ["a", "b", "c", "d"]);
  // Against the direction of the links too: e links to c, not the other way round.
  assert.deepEqual(shortestPath(edges, "a", "e"), ["a", "b", "c", "e"]);
  assert.deepEqual(shortestPath(edges, "d", "a"), ["d", "c", "b", "a"]);
  assert.deepEqual(shortestPath(edges, "a", "a"), ["a"]);
  assert.equal(shortestPath(edges, "a", "f"), null);
  // A shortcut wins over the long way.
  assert.deepEqual(shortestPath([...edges, { from: "a", to: "d" }], "a", "d"), ["a", "d"]);
});
