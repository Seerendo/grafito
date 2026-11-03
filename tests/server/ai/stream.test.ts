import assert from "node:assert/strict";
import { test } from "node:test";
import { ndjsonResponse } from "../../../src/server/ai/stream.ts";

test("NDJSON encodes events and reports producer errors", async () => {
  const response = ndjsonResponse(
    new Request("https://grafito.test"),
    async (emit) => {
      emit({ type: "text", text: "hello\nworld" });
      throw new Error("provider failed");
    },
    () => ({ type: "error", text: "failed" }),
  );
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { type: "text", text: "hello\nworld" },
    { type: "error", text: "failed" },
  ]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("reader cancellation aborts work and suppresses late events", async () => {
  let observed: AbortSignal | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const response = ndjsonResponse(
    new Request("https://grafito.test"),
    async (emit, signal) => {
      observed = signal;
      emit("first");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      emit("late");
      finish();
    },
    () => "error",
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await finished;
  assert.equal(observed?.aborted, true);
});

test("an already aborted request does not start the producer", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  const response = ndjsonResponse(
    new Request("https://grafito.test", { signal: controller.signal }),
    async () => {
      started = true;
    },
    () => "error",
  );
  assert.equal(await response.text(), "");
  assert.equal(started, false);
});
