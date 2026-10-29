import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIMS_WRITE, compactToolResults } from "./guard.ts";
import { contextSize } from "./ollama.ts";
import type { ChatMessage } from "./types.ts";

/** Salvaguardas del asistente: no decir que hizo lo que no hizo, y no pasarse de contexto. */

test("reconoce cuando dice que creó, editó o guardó algo", () => {
  for (const text of [
    "Listo, creé la nota «Plan 2027».",
    "He creado el portafolio Proyectos.",
    "Añadí una sección al final.",
    "La nota quedó guardada en Actas.",
    "Los portafolios están creados.",
    "Done! I've created the note.",
    "The note has been updated.",
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
  ]) {
    assert.ok(!CLAIMS_WRITE.test(text), text);
  }
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
  const messages: ChatMessage[] = [{ role: "tool", toolCallId: "1", name: "read_note", content: "corto" }];
  compactToolResults(messages);
  assert.equal(messages[0]!.content, "corto");
});

test("a Ollama se le pide el contexto que hace falta", () => {
  assert.equal(contextSize([{ role: "user", content: "hola" }], []), 8192);
  assert.equal(contextSize([{ role: "user", content: "x".repeat(40_000) }], []), 16_384);
  assert.equal(contextSize([{ role: "user", content: "x".repeat(500_000) }], []), 32_768);
});
