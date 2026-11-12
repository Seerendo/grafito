import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIMS_WRITE,
  compactToolResults,
  deletionConfirmed,
  deletionQuestion,
  namedInQuestion,
} from "../../../src/server/ai/guard.ts";
import { contextSize } from "../../../src/server/ai/ollama.ts";
import type { ChatMessage } from "../../../src/server/ai/types.ts";

/** Assistant safeguards: prevent unsupported write claims and context overflow. */

test("reconoce cuando dice que creó, editó o guardó algo", () => {
  for (const text of [
    "Listo, creé la nota «Plan 2027».",
    "He creado el portafolio Proyectos.",
    "Añadí una sección al final.",
    "La nota quedó guardada en Actas.",
    "Los portafolios están creados.",
    "Done! I've created the note.",
    "The note has been updated.",
    "Vinculé la frase del PDF con el informe.",
    "He vinculado «acta» con el informe.",
    "La frase quedó vinculada.",
    "I've linked the phrase in the PDF.",
    "The phrase has been linked.",
    "Listo, eliminé la nota «Acta».",
    "He eliminado el archivo.",
    "Borré el portafolio Proyectos.",
    "La nota quedó eliminada.",
    "I've deleted the note.",
    "The file has been removed.",
  ]) {
    assert.ok(CLAIMS_WRITE.test(text), text);
  }
});

test("no confunde preguntas ni lecturas con haberlo hecho", () => {
  for (const text of [
    "¿Quieres que cree la nota?",
    "Puedo crear la nota si me lo confirmas.",
    "Leí «Bienvenida»: habla del grafo.",
    "La nota se creó el 3 de marzo, según su historial.",
    "No encontré ese portafolio. ¿Lo creo?",
    "¿Quieres que vincule esa frase?",
    "Puedo vincular la frase si me lo confirmas.",
    "Para vincular, selecciona el texto del PDF.",
    "¿Quieres que elimine la nota?",
    "Puedo borrar el archivo si me lo confirmas.",
    "Para eliminar, dime el título y el sitio.",
  ]) {
    assert.ok(!CLAIMS_WRITE.test(text), text);
  }
});

test("solo elimina si la persona confirma después de una pregunta", () => {
  const ask = "¿Elimino «Acta» de Actas? Irá a la papelera.";
  assert.equal(
    deletionConfirmed([
      { role: "user", content: "Elimina la nota Acta" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "delete_note", arguments: {} }],
      },
    ]),
    false,
  );
  assert.equal(
    deletionConfirmed([
      { role: "assistant", content: ask },
      { role: "user", content: "sí" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "delete_note", arguments: {} }],
      },
    ]),
    true,
  );
  assert.equal(
    deletionConfirmed([
      { role: "assistant", content: "¿Quieres que cree la nota?" },
      { role: "user", content: "sí" },
    ]),
    false,
  );
  assert.equal(
    deletionConfirmed([
      { role: "assistant", content: "No pude eliminar." },
      { role: "user", content: "ok" },
    ]),
    false,
  );
  assert.equal(
    deletionConfirmed([
      { role: "assistant", content: ask },
      { role: "user", content: "si puedes, elimínala" },
    ]),
    false,
  );
  assert.equal(
    deletionConfirmed([
      { role: "assistant", content: ask },
      { role: "user", content: "sí, elimínala" },
    ]),
    true,
  );
  assert.equal(
    deletionConfirmed([
      { role: "assistant", content: ask },
      { role: "user", content: "sí" },
      {
        role: "user",
        content:
          "(Comprobación automática de Grafito, no la escribió la persona.) pregunta primero",
      },
    ]),
    true,
  );
});

test("un sí solo cubre lo que nombraba la pregunta", () => {
  const ask = "¿Elimino «Acta  de marzo» de Actas? Irá a la papelera.";
  const question = deletionQuestion([
    { role: "assistant", content: ask },
    { role: "user", content: "sí" },
  ]);
  assert.equal(question, ask);
  assert.ok(namedInQuestion(ask, "acta de marzo"));
  assert.ok(namedInQuestion(ask, "Actas"));
  assert.ok(!namedInQuestion(ask, "Presupuesto"));
  assert.ok(!namedInQuestion(ask, "   "));
  assert.equal(
    deletionQuestion([
      { role: "assistant", content: "¿Quieres que cree la nota?" },
      { role: "user", content: "sí" },
    ]),
    null,
  );
});

test("recorta los resultados viejos de herramientas al pasarse, no los últimos", () => {
  const big = "x".repeat(30_000);
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "tool", toolCallId: "1", name: "read_note", content: big },
    { role: "tool", toolCallId: "2", name: "read_note", content: big },
    { role: "tool", toolCallId: "3", name: "read_note", content: big },
  ];
  compactToolResults(messages);
  assert.ok(messages[2]!.content.length < 1000, "el más viejo se recorta");
  assert.equal(messages[3]!.content.length, 30_000);
  assert.equal(messages[4]!.content.length, 30_000);
  assert.equal(messages[0]!.content, "s");
});

test("sin pasarse no recorta nada", () => {
  const messages: ChatMessage[] = [
    { role: "tool", toolCallId: "1", name: "read_note", content: "corto" },
  ];
  compactToolResults(messages);
  assert.equal(messages[0]!.content, "corto");
});

test("a Ollama se le pide el contexto que hace falta", () => {
  assert.equal(contextSize([{ role: "user", content: "hola" }], []), 8192);
  assert.equal(contextSize([{ role: "user", content: "x".repeat(40_000) }], []), 16_384);
  assert.equal(contextSize([{ role: "user", content: "x".repeat(500_000) }], []), 32_768);
});
