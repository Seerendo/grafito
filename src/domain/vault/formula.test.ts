import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFormulas } from "./formula.ts";
import type { TableField } from "./table.ts";

function field(partial: Pick<TableField, "id" | "name" | "type"> & { formula?: string }): TableField {
  return { position: 0, ...partial };
}

const price = field({ id: "p", name: "Precio", type: "number" });
const qty = field({ id: "q", name: "Cantidad", type: "number" });
const total = field({ id: "t", name: "Total", type: "formula", formula: "{Precio} * {Cantidad}" });

test("multiplica dos columnas de la misma fila", () => {
  const run = computeFormulas([price, qty, total], { p: 2.5, q: 4 });
  assert.equal(run.errors.t, undefined);
  assert.equal(run.values.t, 10);
});

test("si, redondear, texto y comparaciones", () => {
  const done = field({ id: "d", name: "Hecho", type: "checkbox" });
  const label = field({ id: "l", name: "Etiqueta", type: "formula", formula: 'si({Hecho}, "sí", "pendiente")' });
  const tax = field({ id: "x", name: "Con IVA", type: "formula", formula: "redondear({Precio} * 1.21, 2)" });
  const run = computeFormulas([price, done, label, tax], { p: 10, d: true });
  assert.equal(run.values.l, "sí");
  assert.equal(run.values.x, 12.1);
  const pending = computeFormulas([done, label], { d: false });
  assert.equal(pending.values.l, "pendiente");
});

test("hoy, dias, vacio, largo, contiene, y, o y no", () => {
  const start = field({ id: "s", name: "Inicio", type: "date" });
  const note = field({ id: "n", name: "Nota", type: "text" });
  const age = field({ id: "a", name: "Días", type: "formula", formula: "dias({Inicio}, hoy())" });
  const blank = field({ id: "b", name: "Vacía", type: "formula", formula: "vacio({Nota})" });
  const size = field({ id: "z", name: "Largo", type: "formula", formula: "largo({Nota})" });
  const has = field({ id: "h", name: "Tiene", type: "formula", formula: 'contiene({Nota}, "ana") y no vacio({Nota})' });
  const run = computeFormulas([start, note, age, blank, size, has], { s: "2026-10-01", n: "Ana" }, "2026-10-29");
  assert.equal(run.values.a, 28);
  assert.equal(run.values.b, false);
  assert.equal(run.values.z, 3);
  assert.equal(run.values.h, true);
  const empty = computeFormulas([note, blank], {}, "2026-10-29");
  assert.equal(empty.values.b, true);
});

test("una fórmula puede usar otra, y un ciclo se señala", () => {
  const a = field({ id: "a", name: "A", type: "formula", formula: "{B} + 1" });
  const b = field({ id: "b", name: "B", type: "formula", formula: "{Precio} * 2" });
  const run = computeFormulas([price, a, b], { p: 3 });
  assert.equal(run.values.b, 6);
  assert.equal(run.values.a, 7);
  const loopA = field({ id: "a", name: "A", type: "formula", formula: "{B}" });
  const loopB = field({ id: "b", name: "B", type: "formula", formula: "{A} + 1" });
  const loop = computeFormulas([loopA, loopB], {});
  assert.equal(loop.values.a, null);
  assert.match(loop.errors.a ?? "", /sí misma|no se entiende/);
});

test("lo que no se entiende no rompe el resto de las columnas", () => {
  const bad = field({ id: "b", name: "Rota", type: "formula", formula: "{Precio} +" });
  const missing = field({ id: "m", name: "Falta", type: "formula", formula: "{Nope}" });
  const run = computeFormulas([price, qty, total, bad, missing], { p: 2, q: 3 });
  assert.equal(run.values.t, 6);
  assert.equal(run.values.b, null);
  assert.match(run.errors.b ?? "", /no se entiende/);
  assert.match(run.errors.m ?? "", /Nope/);
});

test("no divide por cero y concatena con &", () => {
  const div = field({ id: "d", name: "Div", type: "formula", formula: "{Precio} / 0" });
  const join = field({ id: "j", name: "Une", type: "formula", formula: '{Precio} & " €"' });
  const run = computeFormulas([price, div, join], { p: 4 });
  assert.equal(run.values.d, null);
  assert.match(run.errors.d ?? "", /cero/);
  assert.equal(run.values.j, "4 €");
});
