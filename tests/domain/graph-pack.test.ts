import assert from "node:assert/strict";
import { test } from "node:test";
import { packEdges, unpackEdges, type WireEdge } from "../../src/domain/graph-pack.ts";

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
