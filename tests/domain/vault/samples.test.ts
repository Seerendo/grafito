import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  dropDeletedSamples,
  SAMPLE_DOC_IDS,
  SAMPLE_FOLDER_IDS,
} from "../../../src/domain/vault/migrate.ts";

/** Deleted sample documentation stays deleted. */

test("un push no resucita la documentación de ejemplo borrada; lo demás pasa", () => {
  const changes = {
    docs: [{ id: "n-inicio" }, { id: "n-grafo" }, { id: "mi-nota" }],
    deletedDocs: [],
    portfolios: [{ id: "p-documentacion" }, { id: "mi-carpeta" }],
    deletedPortfolios: [],
  };
  const kept = dropDeletedSamples(changes, {
    docs: new Set(["n-inicio"]),
    portfolios: new Set(["p-documentacion"]),
  });
  assert.deepEqual(
    kept.docs.map((doc) => doc.id),
    ["n-grafo", "mi-nota"],
  );
  assert.deepEqual(
    kept.portfolios.map((portfolio) => portfolio.id),
    ["mi-carpeta"],
  );
});

test("las listas de ejemplo coinciden con la semilla", () => {
  const seed = readFileSync(new URL("../../../src/app/vault/seed.ts", import.meta.url), "utf8");
  const docs = [...new Set([...seed.matchAll(/"(n-[a-z]+)"/g)].map((match) => match[1]))].sort();
  assert.deepEqual(docs, [...SAMPLE_DOC_IDS].sort());
  const folders = [...seed.matchAll(/id: "(p-[a-z]+)"/g)].map((match) => match[1]);
  for (const id of folders) assert.ok(SAMPLE_FOLDER_IDS.includes(id), id);
  assert.ok(SAMPLE_FOLDER_IDS.includes("p-documentacion"));
});
