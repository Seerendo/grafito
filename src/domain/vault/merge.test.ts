import assert from "node:assert/strict";
import { test } from "node:test";
import { merge3 } from "./merge.ts";

/** Dos personas guardan la misma nota a partir de la misma versión. */

const base = ["# Plan", "", "Primer párrafo.", "", "Segundo párrafo.", "", "Tercer párrafo."].join("\n");

test("cambios en párrafos distintos se juntan", () => {
  const mine = base.replace("Primer párrafo.", "Primer párrafo, corregido.");
  const theirs = base.replace("Tercer párrafo.", "Tercer párrafo con más datos.");
  const result = merge3(base, mine, theirs);
  assert.deepEqual(result, {
    ok: true,
    text: ["# Plan", "", "Primer párrafo, corregido.", "", "Segundo párrafo.", "", "Tercer párrafo con más datos."].join("\n"),
  });
});

test("borrar un párrafo y editar otro se juntan", () => {
  const mine = base.replace("Segundo párrafo.\n\n", "");
  const theirs = base.replace("Primer párrafo.", "Primer párrafo editado.");
  assert.deepEqual(merge3(base, mine, theirs), {
    ok: true,
    text: ["# Plan", "", "Primer párrafo editado.", "", "Tercer párrafo."].join("\n"),
  });
});

test("borrar el párrafo que la otra persona edita es un conflicto", () => {
  const mine = base.replace("Segundo párrafo.\n\n", "");
  const theirs = base.replace("Segundo párrafo.", "Segundo párrafo, ampliado.");
  assert.deepEqual(merge3(base, mine, theirs), { ok: false });
});

test("la misma línea cambiada de dos formas es un conflicto", () => {
  assert.deepEqual(merge3(base, base.replace("# Plan", "# Plan A"), base.replace("# Plan", "# Plan B")), { ok: false });
});

test("el mismo cambio en las dos no es conflicto", () => {
  const both = base.replace("Tercer", "Último");
  assert.deepEqual(merge3(base, both, both), { ok: true, text: both });
});

test("añadir al final y al principio se juntan", () => {
  const mine = `${base}\n\nNota final.`;
  const theirs = `Resumen.\n\n${base}`;
  assert.deepEqual(merge3(base, mine, theirs), { ok: true, text: `Resumen.\n\n${base}\n\nNota final.` });
});

test("si solo cambió una, gana esa", () => {
  const changed = base.replace("Segundo", "2.º");
  assert.deepEqual(merge3(base, base, changed), { ok: true, text: changed });
  assert.deepEqual(merge3(base, changed, base), { ok: true, text: changed });
});

test("añadir líneas en el mismo hueco es un conflicto", () => {
  const mine = base.replace("Segundo párrafo.", "Segundo párrafo.\nLínea de una.");
  const theirs = base.replace("Segundo párrafo.", "Segundo párrafo.\nLínea de otra.");
  assert.deepEqual(merge3(base, mine, theirs), { ok: false });
});

test("líneas seguidas cambiadas cada una por una persona se juntan", () => {
  const list = ["# Fuentes", "", "- Jacobs, la acera.", "- Perec, un lugar.", "- Notas."].join("\n");
  const mine = list.replace("- Jacobs, la acera.", "- Jacobs, la acera (Carla).");
  const theirs = list.replace("- Perec, un lugar.", "- Perec, un lugar (dueño).");
  assert.deepEqual(merge3(list, mine, theirs), {
    ok: true,
    text: ["# Fuentes", "", "- Jacobs, la acera (Carla).", "- Perec, un lugar (dueño).", "- Notas."].join("\n"),
  });
});
