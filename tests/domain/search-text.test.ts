import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exactPhraseFilter,
  findPassages,
  hitsBeyondTitle,
  INDEX_CAP,
  indexBody,
  markSpans,
  snippet,
} from "../../src/domain/search-text.ts";

test("el cuerpo indexado tiene tope y no guarda nulos", () => {
  const body = indexBody(["  hola\u0000 ", "", "x".repeat(INDEX_CAP)]);
  assert.equal(body.startsWith("hola\n"), true);
  assert.equal(body.length, INDEX_CAP);
  assert.equal(body.includes("\u0000"), false);
});

test("el fragmento rodea la coincidencia sin distinguir mayúsculas", () => {
  const body = `${"a".repeat(200)} INFORME secreto ${"b".repeat(200)}`;
  const found = snippet(body, "informe");
  assert.equal(found.includes("INFORME"), true);
  assert.equal(found.startsWith("…"), true);
  assert.equal(found.endsWith("…"), true);
  assert.ok(found.length < body.length);
});

test("sin la frase entera no hay fragmento", () => {
  assert.equal(snippet("Nota breve", "ausente"), "");
  assert.equal(snippet("", "algo"), "");
  assert.equal(
    findPassages("ESTRUCTURAS de FUNCIONALES", "ESTRUCTURAS FUNCIONALES").items.length,
    0,
  );
});

test("cada aparición de la frase trae su alrededor y conserva las mayúsculas", () => {
  const body = "Inicio ESTRUCTURAS FUNCIONALES medio.\nOtro ESTRUCTURAS FUNCIONALES final.";
  const found = findPassages(body, "estructuras funcionales");
  assert.equal(found.items.length, 2);
  assert.equal(found.more, 0);
  assert.equal(found.items[0]?.match, "ESTRUCTURAS FUNCIONALES");
  assert.equal(found.items[1]?.match, "ESTRUCTURAS FUNCIONALES");
  assert.equal(found.items[0]?.before.includes("Inicio"), true);
  assert.equal(found.items[1]?.after.includes("final"), true);
  const limited = findPassages(body, "estructuras funcionales", 36, 1);
  assert.equal(limited.items.length, 1);
  assert.equal(limited.more, 1);
});

test("un salto de línea entre las palabras sigue siendo la frase", () => {
  const found = findPassages("antes ESTRUCTURAS\nFUNCIONALES después", "ESTRUCTURAS FUNCIONALES");
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0]?.match, "ESTRUCTURAS FUNCIONALES");
});

test("la negrita marca todas las veces de la frase", () => {
  const spans = markSpans("aa FRASE bb FRASE", "frase");
  assert.deepEqual(
    spans.filter((span) => span.mark).map((span) => span.text),
    ["FRASE", "FRASE"],
  );
});

test("el filtro de la barra exige la frase, no un parecido", () => {
  assert.equal(exactPhraseFilter("Nota suelta", "estructuras funcionales"), 0);
  assert.equal(
    exactPhraseFilter("texto ESTRUCTURAS FUNCIONALES texto", "estructuras funcionales"),
    1,
  );
  assert.equal(exactPhraseFilter("crear nota", ""), 1);
});

test("los resultados por contenido no repiten un título que ya coincide", () => {
  const hits = [
    { id: "a", title: "Informe" },
    { id: "b", title: "Notas" },
    { id: "c", title: "Contrato" },
  ];
  const local = [
    { id: "a", title: "Informe" },
    { id: "b", title: "Notas", extra: "informe interno" },
    { id: "c", title: "Contrato" },
  ];
  const beyond = hitsBeyondTitle(hits, local, "informe");
  assert.deepEqual(
    beyond.map((hit) => hit.id),
    ["c"],
  );
  assert.deepEqual(hitsBeyondTitle(hits, local, "i"), []);
  assert.deepEqual(
    hitsBeyondTitle([{ id: "z", title: "Ajeno" }], local, "secreto").map((hit) => hit.id),
    ["z"],
  );
});
