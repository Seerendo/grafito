import assert from "node:assert/strict";
import test from "node:test";
import { visibleWorkspace } from "./workspace-view.ts";

const portfolios = [
  { id: "root", parentId: null },
  { id: "a", parentId: "root" },
  { id: "b", parentId: "root" },
  { id: "a1", parentId: "a" },
];
const documents = [
  { id: "d-root", portfolioId: "root" },
  { id: "d-a", portfolioId: "a" },
  { id: "d-b", portfolioId: "b" },
  { id: "d-a1", portfolioId: "a1" },
];

test("sin concesión solo se ve el espacio, vacío", () => {
  const view = visibleWorkspace("root", portfolios, documents, new Set());
  assert.deepEqual(view.portfolios.map((portfolio) => portfolio.id), ["root"]);
  assert.deepEqual(view.documents, []);
});

test("una concesión no abre las carpetas de dentro ni las hermanas", () => {
  const view = visibleWorkspace("root", portfolios, documents, new Set(["a"]));
  assert.deepEqual(
    view.portfolios.map((portfolio) => portfolio.id),
    ["root", "a"],
  );
  assert.deepEqual(
    view.documents.map((document) => document.id),
    ["d-a"],
  );
});

test("para llegar a una carpeta anidada se ven los padres, sin sus documentos", () => {
  const view = visibleWorkspace("root", portfolios, documents, new Set(["a1"]));
  assert.deepEqual(
    view.portfolios.map((portfolio) => portfolio.id),
    ["root", "a", "a1"],
  );
  assert.deepEqual(
    view.documents.map((document) => document.id),
    ["d-a1"],
  );
});

test("replicar deja cada carpeta concedida con sus documentos", () => {
  const view = visibleWorkspace("root", portfolios, documents, new Set(["a", "a1"]));
  assert.deepEqual(
    view.documents.map((document) => document.id),
    ["d-a", "d-a1"],
  );
});
