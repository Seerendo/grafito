import assert from "node:assert/strict";
import test from "node:test";
import { readAnswer } from "../../src/lib/http-answer.ts";

/** Reading JSON answers of upload requests. */

/** A response whose body fails while it is read (a cancelled request). */
function breaking(status: number, controller: AbortController): Response {
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"etag":'));
      controller.signal.addEventListener("abort", () =>
        stream.error(new DOMException("aborted", "AbortError")),
      );
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("una respuesta correcta devuelve su cuerpo", async () => {
  const answer = await readAnswer<{ etag: string }>(Response.json({ etag: "x" }));
  assert.deepEqual(answer, { ok: true, body: { etag: "x" } });
});

test("un error devuelve su estado y su mensaje", async () => {
  const answer = await readAnswer(Response.json({ error: "No." }, { status: 422 }));
  assert.deepEqual(answer, { ok: false, status: 422, error: "No." });
});

test("cancelada mientras se lee: se propaga la cancelación, no un éxito vacío", async () => {
  const controller = new AbortController();
  const reading = readAnswer(breaking(200, controller), controller.signal);
  controller.abort();
  await assert.rejects(reading, (error: Error) => error.name === "AbortError");
});

test("un 2xx sin cuerpo legible no cuenta como éxito", async () => {
  const answer = await readAnswer(new Response("<html>", { status: 200 }));
  assert.deepEqual(answer, { ok: false, status: 200, error: "" });
});
