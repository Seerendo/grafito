import assert from "node:assert/strict";
import test from "node:test";
import { NO_RULES, parseRules } from "../../../src/domain/file-extensions.ts";
import {
  blockedByFolder,
  countBatch,
  failureState,
  nextPending,
  planBatch,
} from "../../../src/domain/vault/upload-batch.ts";

/** Background upload batches: plan, progress and summary. */

const files = [
  { relativePath: "Obra/planos/a.pdf", size: 100 },
  { relativePath: "Obra/copia.rar", size: 50 },
  { relativePath: "Obra/.DS_Store", size: 1 },
  { relativePath: "suelto.txt", size: 10 },
];

test("carpetas primero, luego archivos; los bloqueados quedan omitidos con su motivo", () => {
  const entries = planBatch(files, ["Obra/vacía"], parseRules("rar", ""));
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.path, entry.state]),
    [
      ["folder", "Obra", "pending"],
      ["folder", "Obra/planos", "pending"],
      ["folder", "Obra/vacía", "pending"],
      ["file", "Obra/planos/a.pdf", "pending"],
      ["file", "Obra/copia.rar", "skipped"],
      ["file", "suelto.txt", "pending"],
    ],
  );
  assert.equal(entries[4]?.reason, "No se permite subir archivos .rar («copia.rar»).");
  assert.equal(entries[3]?.source, 0);
  assert.equal(entries[5]?.source, 3);
});

test("el recuento separa subidos, omitidos, antivirus, fallidos y pendientes", () => {
  const entries = planBatch(files, ["Obra/vacía"], parseRules("rar", ""));
  for (const entry of entries.slice(0, 3)) entry.state = "done";
  entries[3]!.state = "infected";
  entries[5]!.state = "done";
  const counts = countBatch(entries);
  assert.deepEqual(counts.folders, { total: 3, done: 3, failed: 0 });
  assert.deepEqual(counts.files, {
    total: 3,
    done: 1,
    skipped: 1,
    infected: 1,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(counts.bytes, { total: 160, done: 10 });
  assert.equal(nextPending(entries), -1);
});

test("reanudar sigue por el primero pendiente", () => {
  const entries = planBatch(files, [], NO_RULES);
  entries[0]!.state = "done";
  entries[1]!.state = "done";
  assert.equal(nextPending(entries), 2);
});

test("una carpeta que no se pudo crear arrastra a su contenido", () => {
  const entries = planBatch(files, [], NO_RULES);
  entries[0]!.state = "failed";
  entries[0]!.reason = "No puedes crear portafolios aquí.";
  const pdf = entries.findIndex((entry) => entry.path === "Obra/planos/a.pdf");
  assert.equal(blockedByFolder(entries, 1), "No puedes crear portafolios aquí.");
  assert.equal(blockedByFolder(entries, pdf), null);
  assert.equal(blockedByFolder(entries, entries.length - 1), null);
});

test("estado de un rechazo según el código del servidor", () => {
  assert.equal(failureState(422), "infected");
  assert.equal(failureState(415), "skipped");
  assert.equal(failureState(503), "failed");
  assert.equal(failureState(null), "failed");
});
