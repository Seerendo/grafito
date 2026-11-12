import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chunkOps,
  docNode,
  docOps,
  edgeRows,
  namespaceFor,
  nodeId,
  portfolioOps,
  refNode,
  titleNode,
} from "../../../src/server/graph/model.ts";

/** How a vault is written into Grafeno. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("cada registro tiene un UUID estable", () => {
  assert.match(nodeId("doc:p-atlas"), UUID);
  assert.equal(docNode("a"), docNode("a"));
  assert.notEqual(docNode("a"), refNode("a"));
  // Titles match without case, as findByTitle does.
  assert.equal(titleNode(" Plan "), titleNode("plan"));
  assert.notEqual(refNode("x"), refNode("x", "share"));
});

test("el namespace es legible si el id lo permite", () => {
  assert.equal(namespaceFor("grafito-", "bench-u0001"), "grafito-bench-u0001");
  const hashed = namespaceFor("grafito-", "uid=ana,ou=people");
  assert.match(hashed, /^grafito-[0-9a-f]{32}$/);
});

test("una nota reemplaza sus vínculos y apunta a títulos y referencias, no a destinos", () => {
  const ops = docOps({
    id: "a",
    title: "Alfa",
    kind: "markdown",
    content: "ver [[Beta]] y [[alfa]] y `[[código]]`",
    links: [
      { targetId: "c", kind: "referencia" },
      { targetId: "c", kind: "referencia" },
      { targetId: "s1", kind: "llama", shareId: "share", target: "portfolio" },
    ],
  });
  assert.deepEqual(ops[1], { op: "delete_edges_from", from: docNode("a") });
  const edges = ops.flatMap((op) => (op.op === "create_edge" ? [op.edge] : []));
  assert.deepEqual(
    edges.map((edge) => [edge.label, edge.to]),
    [
      ["is", refNode("a")],
      ["titled", titleNode("alfa")],
      // The link to its own title and the one inside code are not links.
      ["wiki", titleNode("beta")],
      // The repeated link is written once.
      ["referencia", refNode("c")],
      ["llama", refNode("s1", "share")],
    ],
  );
  const shared = ops.find((op) => op.op === "upsert_node" && op.node.id === refNode("s1", "share"));
  assert.deepEqual(shared && shared.op === "upsert_node" ? shared.node.props : null, {
    gid: "s1",
    share: "share",
    target: "portfolio",
  });
});

test("un archivo tiene título para los [[enlaces]] pero no lee su contenido", () => {
  const ops = docOps({ id: "f", title: "Plano", kind: "file", content: "[[Otro]]", links: [] });
  const labels = ops.flatMap((op) => (op.op === "create_edge" ? [op.edge.label] : []));
  assert.deepEqual(labels, ["is", "titled"]);
});

test("un portafolio no tiene título: los [[enlaces]] no llegan a él", () => {
  const ops = portfolioOps({ id: "p", links: [{ targetId: "a", kind: "referencia" }] });
  const labels = ops.flatMap((op) => (op.op === "create_edge" ? [op.edge.label] : []));
  assert.deepEqual(labels, ["is", "referencia"]);
});

test("los lotes no parten las operaciones de un registro", () => {
  const groups = [
    Array(3).fill({ op: "delete_node", id: "x" }),
    Array(3).fill({ op: "delete_node", id: "y" }),
  ];
  assert.deepEqual(
    chunkOps(groups, 4).map((batch) => batch.length),
    [3, 3],
  );
});

test("las filas de aristas se limpian y se deduplican", () => {
  assert.deepEqual(
    edgeRows([
      ["a", "wiki", "b", null, null],
      ["a", "wiki", "b", null, null],
      ["a", "wiki", "a", null, null],
      ["a", "is", "b", null, null],
      ["a", "llama", "s1", "share", "portfolio"],
      ["a", "referencia", "p", null, "portfolio"],
    ]),
    [
      { from: "a", to: "b", kind: "wiki" },
      { from: "a", to: "s1", kind: "llama", shareId: "share", target: "portfolio" },
      { from: "a", to: "p", kind: "referencia", target: "portfolio" },
    ],
  );
});
