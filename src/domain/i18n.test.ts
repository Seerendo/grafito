import assert from "node:assert/strict";
import { test } from "node:test";
import { translate } from "./i18n.ts";

/** Traducción de la interfaz: claves directas, variables y patrones de mensajes del servidor. */

test("español: el texto tal cual, con sus variables", () => {
  assert.equal(translate("es", "Guardar"), "Guardar");
  assert.equal(translate("es", "Editar {0}", { 0: "Atlas" }), "Editar Atlas");
});

test("inglés: clave directa y variables", () => {
  assert.equal(translate("en", "Guardar"), "Save");
  assert.equal(translate("en", "Compartir «{0}»", { 0: "Atlas" }), "Share «Atlas»");
});

test("inglés: un mensaje ya armado del servidor se reconoce como patrón", () => {
  assert.equal(translate("en", "Conecta Ollama en tu cuenta (Cuenta → IA)."), "Connect Ollama in your account (Account → AI).");
  assert.equal(translate("en", "«plano.pdf» supera el límite de 100 MB."), "«plano.pdf» exceeds the 100 MB limit.");
  assert.equal(translate("en", "Elimina a Lectora"), "Deletes Lectora");
});

test("sin traducción: se queda en español", () => {
  assert.equal(translate("en", "Texto que nadie tradujo"), "Texto que nadie tradujo");
  assert.equal(translate("en", ""), "");
});
