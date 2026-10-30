import assert from "node:assert/strict";
import test from "node:test";
import { folderPlan, ignoredUpload } from "./folders.ts";

test("una carpeta con subcarpetas se crea de fuera hacia dentro", () => {
  const plan = folderPlan(["Informes/2024/a.pdf", "Informes/b.pdf", "suelto.txt"]);
  assert.deepEqual(plan.folders, ["Informes", "Informes/2024"]);
  assert.deepEqual(plan.files, [
    { relativePath: "Informes/2024/a.pdf", folder: "Informes/2024" },
    { relativePath: "Informes/b.pdf", folder: "Informes" },
    { relativePath: "suelto.txt", folder: "" },
  ]);
});

test("los archivos de sistema no se suben", () => {
  assert.equal(ignoredUpload("Informes/.DS_Store"), true);
  assert.equal(ignoredUpload("Thumbs.db"), true);
  assert.equal(ignoredUpload("Informes/nota.md"), false);
});

test("una ruta que sale de la carpeta no se crea", () => {
  const plan = folderPlan(["../secreto.txt", "ok/nota.md"]);
  assert.deepEqual(plan.folders, ["ok"]);
  assert.deepEqual(plan.files, [{ relativePath: "ok/nota.md", folder: "ok" }]);
});
