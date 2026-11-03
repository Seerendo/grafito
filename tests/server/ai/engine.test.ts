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
