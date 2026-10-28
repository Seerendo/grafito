import assert from "node:assert/strict";
import { test } from "node:test";
import { graphEdges, type GraphNode } from "./graph.ts";

/** Vínculos a portafolios y a lo compartido conmigo en el grafo. */

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: id,
  kind: "markdown",
  content: "",
  links: [],
  pinned: false,
  ...extra,
});

test("aristas hacia portafolios y destinos compartidos que están en el grafo", () => {
  const nodes = [
    node("a", { links: [{ targetId: "p1", kind: "referencia", target: "portfolio" }, { targetId: "s1", kind: "llama", shareId: "share" }] }),
    node("p1", { kind: "portfolio", links: [{ targetId: "a", kind: "referencia" }] }),
    node("s1", { shared: true }),
  ];
  assert.deepEqual(graphEdges(nodes), [
    { from: "a", to: "p1", kind: "referencia" },
    { from: "a", to: "s1", kind: "llama" },
    { from: "p1", to: "a", kind: "referencia" },
  ]);
});

test("un vínculo a algo que ya no se ve no dibuja arista", () => {
  const nodes = [node("a", { links: [{ targetId: "gone", kind: "referencia", shareId: "share" }] })];
  assert.deepEqual(graphEdges(nodes), []);
});

test("los [[enlaces]] no van a lo compartido ni a portafolios con el mismo nombre", () => {
  const nodes = [
    node("a", { content: "ver [[Plan]]" }),
    node("s1", { title: "Plan", shared: true }),
    node("p1", { title: "Plan", kind: "portfolio" }),
  ];
  assert.deepEqual(graphEdges(nodes), []);
});
