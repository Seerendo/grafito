import assert from "node:assert/strict";
import test from "node:test";
import { NO_RULES, parseRules } from "../../../src/domain/file-extensions.ts";
import {
  BatchProgress,
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
    existing: 0,
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

test("el progreso incremental cuenta igual que el recuento completo", () => {
  const entries = planBatch(files, ["Obra/vacía"], parseRules("rar", ""));
  const batch = new BatchProgress(entries);
  batch.set(0, "done");
  batch.set(1, "done");
  batch.set(2, "failed", "No puedes crear portafolios aquí.");
  batch.set(3, "done");
  batch.set(5, "existing");
  assert.deepEqual(batch.counts, countBatch(entries));
  assert.equal(batch.counts.files.existing, 1);
  assert.equal(batch.counts.bytes.done, 100);
  assert.deepEqual(
    batch.problems.map((problem) => [problem.path, problem.state]),
    [
      ["Obra/copia.rar", "skipped"],
      ["Obra/vacía", "failed"],
    ],
  );
});

test("una carpeta fallida bloquea lo que contiene y nada cae en la raíz", () => {
  const entries = planBatch(
    [
      { relativePath: "A/B/c.pdf", size: 1 },
      { relativePath: "A/d.pdf", size: 1 },
    ],
    [],
    NO_RULES,
  );
  const batch = new BatchProgress(entries);
  assert.equal(batch.nextFolder(), 0);
  batch.set(0, "done");
  assert.equal(batch.nextFolder(), 1);
  batch.set(1, "failed", "La carpeta de destino ya no existe.");
  assert.equal(batch.nextFolder(), -1);
  const file = entries.findIndex((entry) => entry.path === "A/B/c.pdf");
  assert.equal(batch.blocked(entries[file]!), "La carpeta de destino ya no existe.");
  const sibling = entries.findIndex((entry) => entry.path === "A/d.pdf");
  assert.equal(batch.blocked(entries[sibling]!), null);
});

test("los archivos se reparten sin repetir los que están en curso", () => {
  const entries = planBatch(
    [
      { relativePath: "a.pdf", size: 1 },
      { relativePath: "b.pdf", size: 1 },
      { relativePath: "c.pdf", size: 1 },
    ],
    [],
    NO_RULES,
  );
  const batch = new BatchProgress(entries);
  const flight = new Set<number>();
  const first = batch.claimFile(flight);
  flight.add(first);
  const second = batch.claimFile(flight);
  flight.add(second);
  assert.notEqual(first, second);
  batch.set(first, "done");
  flight.delete(first);
  const third = batch.claimFile(flight);
  assert.ok(third !== first && third !== second);
  flight.add(third);
  assert.equal(batch.claimFile(flight), -1);
  // A pause leaves the ones in flight pending: after rewinding they are handed out again.
  flight.clear();
  batch.rewind();
  assert.equal(batch.claimFile(flight), second);
  assert.equal(batch.finished(), false);
  batch.set(second, "done");
  batch.set(third, "failed", "x");
  assert.equal(batch.finished(), true);
});

test("planificar y recorrer miles de entradas no crece de forma cuadrática", () => {
  const many = Array.from({ length: 20_000 }, (_, index) => ({
    relativePath: `R/c${index % 400}/f${index}.pdf`,
    size: 10,
  }));
  const started = performance.now();
  const entries = planBatch(many, [], NO_RULES);
  const batch = new BatchProgress(entries);
  for (let index = batch.nextFolder(); index !== -1; index = batch.nextFolder())
    batch.set(index, "done");
  const flight = new Set<number>();
  for (let index = batch.claimFile(flight); index !== -1; index = batch.claimFile(flight)) {
    assert.equal(batch.blocked(entries[index]!), null);
    batch.set(index, "done");
  }
  assert.equal(batch.counts.files.done, 20_000);
  assert.equal(batch.finished(), true);
  // Generous bound for slow machines; a quadratic walk over 20 000 entries is far slower.
  const ms = performance.now() - started;
  assert.ok(ms < 5000, `${Math.round(ms)} ms`);
});
