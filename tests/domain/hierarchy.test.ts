import assert from "node:assert/strict";
import { test } from "node:test";
import { subtreeIds } from "../../src/domain/hierarchy.ts";
import { orgSubtree, wouldCycle } from "../../src/domain/orgs.ts";
import { buildForest } from "../../src/domain/vault/portfolios.ts";

test("subtree traversal handles reversed deep input and cycles", () => {
  const items = Array.from({ length: 10_000 }, (_, i) => ({
    id: String(i),
    name: String(i),
    parentId: i ? String(i - 1) : null,
  })).reverse();
  assert.equal(orgSubtree(items, "0").size, items.length);
  assert.equal(wouldCycle(items, "0", "9999"), true);
  assert.deepEqual(
    subtreeIds(
      [
        { id: "a", parentId: "b" },
        { id: "b", parentId: "a" },
      ],
      "a",
    ),
    new Set(["a", "b"]),
  );
});

test("forest construction supports deep imports without recursive stack growth", () => {
  const items = Array.from({ length: 10_000 }, (_, i) => ({
    id: String(i),
    name: String(i),
    parentId: i ? String(i - 1) : null,
  })).reverse();
  const forest = buildForest(items, []);
  assert.equal(forest.roots.length, 1);
  let node = forest.roots[0];
  let count = 1;
  while (node.children.length) {
    node = node.children[0];
    count += 1;
  }
  assert.equal(count, items.length);
});

test("forest sorts siblings and excludes orphaned/cyclic branches from roots", () => {
  const forest = buildForest(
    [
      { id: "z", name: "Zulu", parentId: null },
      { id: "a", name: "Alpha", parentId: null },
      { id: "b", name: "Beta", parentId: "a" },
      { id: "c", name: "Alpha", parentId: "a" },
      { id: "orphan", name: "Orphan", parentId: "missing" },
      { id: "cycle", name: "Cycle", parentId: "cycle" },
    ],
    [],
  );
  assert.deepEqual(
    forest.roots.map((n) => n.portfolio.id),
    ["a", "z"],
  );
  assert.deepEqual(
    forest.roots[0].children.map((n) => n.portfolio.id),
    ["c", "b"],
  );
  assert.doesNotThrow(() => JSON.stringify(forest));
});
