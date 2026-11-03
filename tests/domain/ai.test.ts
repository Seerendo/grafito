import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_PROVIDERS, aiProvider, splitModelRef } from "../../src/domain/ai.ts";

/** OpenRouter appears in the cloud provider catalog using the OpenAI protocol. */

test("OpenRouter usa la API oficial y el protocolo de OpenAI", () => {
  const provider = aiProvider("openrouter");
  assert.ok(provider);
  assert.equal(provider?.protocol, "openai");
  assert.equal(provider?.local, false);
  assert.equal(provider?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(provider?.keyPlaceholder, "sk-or-…");
  assert.equal(AI_PROVIDERS.filter((item) => item.id === "openrouter").length, 1);
});

test("la referencia parte por el primer dos puntos, así el modelo de OpenRouter puede llevar barra", () => {
  assert.deepEqual(splitModelRef("openrouter:openai/gpt-4o-mini"), {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
  });
  assert.equal(splitModelRef("desconocido:modelo"), null);
});
