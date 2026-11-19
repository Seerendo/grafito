import assert from "node:assert/strict";
import test from "node:test";
import { tallyFolder } from "../../../src/domain/vault/tally.ts";

/** Folder and file counts, direct and below. */

const portfolios = [
  { id: "obra", parentId: null },
  { id: "planos", parentId: "obra" },
  { id: "vacia", parentId: "obra" },
  { id: "detalle", parentId: "planos" },
  { id: "otro", parentId: null },
];
const documents = [
  { portfolioId: "obra" },
  { portfolioId: "planos" },
  { portfolioId: "planos" },
  { portfolioId: "detalle" },
  { portfolioId: "otro" },
  { portfolioId: null },
];

test("dentro directamente y en total, como en un explorador de archivos", () => {
  assert.deepEqual(tallyFolder(portfolios, documents, "obra"), {
    direct: { folders: 2, files: 1 },
    total: { folders: 3, files: 4 },
  });
  assert.deepEqual(tallyFolder(portfolios, documents, "vacia"), {
    direct: { folders: 0, files: 0 },
    total: { folders: 0, files: 0 },
  });
});

test("la raíz personal cuenta todo", () => {
  assert.deepEqual(tallyFolder(portfolios, documents, null), {
    direct: { folders: 2, files: 1 },
    total: { folders: 5, files: 6 },
  });
});

test("un ciclo no cuelga el recuento", () => {
  const loop = [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
    { id: "r", parentId: null },
    { id: "c", parentId: "r" },
  ];
  assert.deepEqual(tallyFolder(loop, [], "a").total.folders, 2);
});
