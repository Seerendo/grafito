import assert from "node:assert/strict";
import { test } from "node:test";
import {
  packAnalysis,
  packEdges,
  unpackAnalysis,
  unpackEdges,
  type WireEdge,
} from "../../src/domain/graph-pack.ts";

/** Graph links on the wire: each id once, five numbers per link. */

test("los vínculos llegan iguales y cada id viaja una vez", () => {
  const edges: WireEdge[] = [
    { from: "a", to: "b", kind: "wiki" },
    { from: "b", to: "a", kind: "referencia" },
    { from: "a", to: "s1", kind: "llama", shareId: "share", target: "portfolio" },
    { from: "c", to: "p", kind: "referencia", target: "portfolio" },
  ];
  const packed = packEdges(edges);
  assert.deepEqual(packed.ids.split(String.fromCharCode(10)), ["a", "b", "s1", "c", "p"]);
  assert.equal(packed.shares, "share");
  assert.equal(packed.edges.split(",").length, edges.length * 5);
  assert.deepEqual(unpackEdges(packed), edges);
  assert.deepEqual(unpackEdges({ ids: "", shares: "", edges: "" }), []);
});

test("comunidad e importancia viajan solo para lo visible, escaladas a 0–1000", () => {
  const packed = packAnalysis(
    { ids: ["a", "b", "c"], community: [0, 1, 0], rank: [0.5, 0.25, 0.1], bridge: [0, 40, 80] },
    (id) => id !== "c",
  );
  const back = unpackAnalysis(packed);
  assert.deepEqual([...back.keys()], ["a", "b"]);
  // Scaled against what is shown: c, the top bridge, is left out.
  assert.deepEqual(back.get("a"), { community: 0, rank: 1000, bridge: 0 });
  assert.deepEqual(back.get("b"), { community: 1, rank: 500, bridge: 1000 });
  assert.equal(unpackAnalysis(packAnalysis(null)).size, 0);
  assert.equal(unpackAnalysis(undefined).size, 0);
});
