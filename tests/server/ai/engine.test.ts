import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAgent } from "../../../src/server/ai/engine.ts";

test("cancellation prevents subsequent tools from writing", async () => {
  const controller = new AbortController();
  let writes = 0;
  await assert.rejects(
    executeAgent({
      messages: [],
      signal: controller.signal,
      emit: () => {},
      complete: async () => ({
        text: "",
        toolCalls: [
          { id: "1", name: "create_note", arguments: {} },
          { id: "2", name: "create_note", arguments: {} },
        ],
      }),
      tools: {
        specs: [],
        run: async () => {
          writes += 1;
          controller.abort();
          return { content: "ok", event: { label: "Created", ok: true, changed: true } };
        },
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(writes, 1);
});

test("un borrado en el mismo turno no llega a ejecutarse", async () => {
  let writes = 0;
  let step = 0;
  await executeAgent({
    messages: [{ role: "user", content: "Elimina la nota Acta" }],
    emit: () => {},
    complete: async () => {
      step += 1;
      if (step === 1) {
        return {
          text: "",
          toolCalls: [{ id: "1", name: "delete_note", arguments: { id: "Acta" } }],
        };
      }
      return { text: "¿Elimino «Acta»? Irá a la papelera.", toolCalls: [] };
    },
    tools: {
      specs: [
        {
          name: "delete_note",
          description: "borra",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
      run: async () => {
        writes += 1;
        return { content: "ok", event: { label: "Eliminó", ok: true, changed: true } };
      },
    },
  });
  assert.equal(writes, 0);
});

test("un borrado confirmado sí se ejecuta", async () => {
  let writes = 0;
  let question = "";
  let step = 0;
  await executeAgent({
    messages: [
      { role: "assistant", content: "¿Elimino «Acta»? Irá a la papelera." },
      { role: "user", content: "sí" },
    ],
    emit: () => {},
    complete: async () => {
      step += 1;
      if (step === 1) {
        return {
          text: "",
          toolCalls: [{ id: "1", name: "delete_note", arguments: { id: "Acta" } }],
        };
      }
      return { text: "Quedó en la papelera.", toolCalls: [] };
    },
    tools: {
      specs: [
        {
          name: "delete_note",
          description: "borra",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
      run: async (_call, context) => {
        writes += 1;
        question = context?.deleteQuestion ?? "";
        return { content: "ok", event: { label: "Eliminó", ok: true, changed: true } };
      },
    },
  });
  assert.equal(writes, 1);
  // The tool receives the question, so it can check that the target was the one named.
  assert.equal(question, "¿Elimino «Acta»? Irá a la papelera.");
});
