import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCell, compareKeys, guessType, isTableName, parseCsv, toCsv } from "./table.ts";

/** Tablas de datos: valores por tipo, orden y CSV. */

test("una tabla se reconoce por su extensión", () => {
  assert.ok(isTableName("Inventario.tabla"));
  assert.ok(!isTableName("Inventario.csv"));
});

test("cada tipo guarda solo lo que le corresponde", () => {
  assert.equal(cleanCell("number", "1,5"), 1.5);
  assert.equal(cleanCell("number", "abc"), null);
  assert.equal(cleanCell("date", "2026-10-29"), "2026-10-29");
  assert.equal(cleanCell("date", "29/10/2026"), "2026-10-29");
  assert.equal(cleanCell("date", "mañana"), null);
  assert.equal(cleanCell("checkbox", "sí"), true);
  assert.equal(cleanCell("checkbox", "no"), null);
  assert.equal(cleanCell("text", ""), null);
  assert.equal(cleanCell("text", 42), "42");
  assert.deepEqual(cleanCell("link", [{ id: "a", kind: "document" }, { id: "a", kind: "document" }, { id: "b", kind: "otro" }]), [
    { id: "a", kind: "document" },
  ]);
  assert.equal(cleanCell("link", "a"), null);
  assert.deepEqual(cleanCell("file", [{ id: "f", kind: "document" }, { id: "p", kind: "portfolio" }]), [{ id: "f", kind: "document" }]);
  assert.deepEqual(
    cleanCell("relation", [
      { tableId: "t", rowId: "r" },
      { tableId: "t", rowId: "r" },
      { tableId: "", rowId: "x" },
    ]),
    [{ tableId: "t", rowId: "r" }],
  );
  assert.equal(cleanCell("relation", "fila"), null);

});

test("al ordenar, las vacías van al final y los números como números", () => {
  const values = [10, "", 2].sort(compareKeys);
  assert.deepEqual(values, [2, 10, ""]);
  assert.ok(compareKeys("árbol", "Casa") < 0);
});

test("lee CSV con comillas, saltos de línea dentro y punto y coma", () => {
  assert.deepEqual(parseCsv('Nombre,Nota\n"Pérez, Ana","Dijo ""hola""\ny se fue"\n'), [
    ["Nombre", "Nota"],
    ["Pérez, Ana", 'Dijo "hola"\ny se fue'],
  ]);
  assert.deepEqual(parseCsv("a;b\n1;2\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("escribir y volver a leer un CSV deja lo mismo", () => {
  const rows = [
    ["Título", "Detalle"],
    ["Uno", 'con "comillas", comas\ny saltos'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("adivina el tipo de una columna importada", () => {
  assert.equal(guessType(["1", "2,5", ""]), "number");
  assert.equal(guessType(["2026-01-02", "31/12/2025"]), "date");
  assert.equal(guessType(["sí", "no"]), "checkbox");
  assert.equal(guessType(["Ana", "3"]), "text");
});
