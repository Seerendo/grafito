import assert from "node:assert/strict";
import { test } from "node:test";
import * as anthropic from "./anthropic.ts";
import * as gemini from "./gemini.ts";
import * as ollama from "./ollama.ts";
import * as openai from "./openai.ts";
import type { ChatMessage, ToolSpec } from "./types.ts";

/**
 * Traducción de cada adaptador con cuerpos de ejemplo de cada API, y la
 * petición HTTP que arma (URL y cabeceras) con un `fetch` falso.
 */

const tools: ToolSpec[] = [
  {
    name: "read_note",
    description: "Lee una nota",
    parameters: { type: "object", properties: { id: { type: "string", description: "Id" } }, required: ["id"] },
  },
];

const history: ChatMessage[] = [
  { role: "system", content: "Eres el asistente." },
  { role: "user", content: "¿Qué dice la nota A?" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_note", arguments: { id: "a" } }, { id: "c2", name: "read_note", arguments: { id: "b" } }] },
  { role: "tool", toolCallId: "c1", name: "read_note", content: '{"title":"A"}' },
  { role: "tool", toolCallId: "c2", name: "read_note", content: '{"title":"B"}' },
];

function fakeFetch(reply: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("openai: herramientas, llamadas y resultados", () => {
  const body = openai.toRequest("gpt-x", history, tools);
  assert.equal(body.tools?.[0]?.function.name, "read_note");
  const assistant = body.messages[2] as { tool_calls: { function: { arguments: string } }[] };
  assert.equal(assistant.tool_calls[0]!.function.arguments, '{"id":"a"}');
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: '{"title":"A"}' });

  const completion = openai.fromResponse({
    choices: [
      { message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "read_note", arguments: '{"id":"z"}' } }] } },
    ],
  });
  assert.deepEqual(completion, { text: "", toolCalls: [{ id: "x", name: "read_note", arguments: { id: "z" } }] });
});

test("openai: URL y Authorization", async () => {
  const { fetcher, calls } = fakeFetch({ choices: [{ message: { content: "hola" } }] });
  const result = await openai.complete({
    endpoint: { baseUrl: "https://api.x.ai/v1/", apiKey: "k" },
    model: "grok",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    fetcher,
  });
  assert.equal(result.text, "hola");
  assert.equal(calls[0]!.url, "https://api.x.ai/v1/chat/completions");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer k");
});

test("anthropic: sistema aparte y resultados agrupados en un solo turno user", () => {
  const body = anthropic.toRequest("claude-x", history, tools);
  assert.equal(body.system, "Eres el asistente.");
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.tools?.[0]?.input_schema.type, "object");
  assert.equal(body.messages.length, 3);
  assert.deepEqual(
    body.messages[1]!.content.map((block) => block.type),
    ["tool_use", "tool_use"],
  );
  assert.deepEqual(
    body.messages[2]!.content.map((block) => block.type),
    ["tool_result", "tool_result"],
  );

  const completion = anthropic.fromResponse({
    content: [
      { type: "text", text: "Voy a leerla." },
      { type: "tool_use", id: "toolu_1", name: "read_note", input: { id: "q" } },
    ],
    stop_reason: "tool_use",
  });
  assert.equal(completion.text, "Voy a leerla.");
  assert.deepEqual(completion.toolCalls, [{ id: "toolu_1", name: "read_note", arguments: { id: "q" } }]);
});

test("anthropic: cabeceras x-api-key y anthropic-version", async () => {
  const { fetcher, calls } = fakeFetch({ content: [{ type: "text", text: "ok" }] });
  await anthropic.complete({
    endpoint: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant" },
    model: "claude",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    fetcher,
  });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], "sk-ant");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("gemini: functionDeclarations, roles model/user y functionResponse", () => {
  const body = gemini.toRequest(history, tools);
  assert.equal(body.systemInstruction?.parts[0]?.text, "Eres el asistente.");
  assert.equal(body.tools?.[0]?.functionDeclarations[0]?.name, "read_note");
  assert.deepEqual(
    body.contents.map((content) => content.role),
    ["user", "model", "user"],
  );
  assert.deepEqual(body.contents[2]!.parts[0], { functionResponse: { name: "read_note", response: { content: { title: "A" } } } });

  const completion = gemini.fromResponse({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_note", args: { id: "g" } } }] } }],
  });
  assert.equal(completion.toolCalls[0]!.name, "read_note");
  assert.deepEqual(completion.toolCalls[0]!.arguments, { id: "g" });
});

test("gemini: URL con el modelo y x-goog-api-key", async () => {
  const { fetcher, calls } = fakeFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  const result = await gemini.complete({
    endpoint: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIza" },
    model: "gemini-pro",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    fetcher,
  });
  assert.equal(result.text, "ok");
  assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], "AIza");
});

test("ollama: argumentos como objeto y tool_name en los resultados", () => {
  const body = ollama.toRequest("llama", history, tools);
  assert.equal(body.stream, false);
  const assistant = body.messages[2] as { tool_calls: { function: { arguments: Record<string, unknown> } }[] };
  assert.deepEqual(assistant.tool_calls[0]!.function.arguments, { id: "a" });
  assert.deepEqual(body.messages[3], { role: "tool", content: '{"title":"A"}', tool_name: "read_note" });

  const completion = ollama.fromResponse({
    message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_note", arguments: { id: "o" } } }] },
  });
  assert.deepEqual(completion.toolCalls[0]!.arguments, { id: "o" });
});

test("errores del proveedor con un mensaje legible", async () => {
  const fetcher = (async () =>
    new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    openai.complete({ endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: "x" }, model: "m", messages: [], tools: [], fetcher }),
    /401\. La clave no es válida o no tiene permiso\. Incorrect API key/,
  );
});
