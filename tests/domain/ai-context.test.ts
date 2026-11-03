import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLD_CHARS,
  LATEST_USER_CHARS,
  MEMORY_CHARS,
  MEMORY_MARK,
  RECENT_TURNS,
  clipSummary,
  fallbackMemory,
  planContext,
  summaryRequest,
  withMemory,
  type ContextTurn,
} from "../../src/domain/ai-context.ts";

function talk(count: number, size = 20): ContextTurn[] {
  return Array.from({ length: count }, (_, index) => {
    const role = index % 2 === 0 ? ("user" as const) : ("assistant" as const);
    return {
      id: `t${index + 1}`,
      role,
      content: `t${index + 1} ${"x".repeat(size)}`,
      ...(role === "assistant" ? { tools: [{ label: `acc ${index + 1}` }] } : {}),
    };
  });
}

test("una conversación corta se manda entera y con las acciones", () => {
  const plan = planContext(talk(3, 30), null);
  assert.equal(plan.fold, null);
  assert.equal(plan.next, null);
  assert.equal(plan.recent[0]?.role, "user");
  assert.equal(plan.recent.at(-1)?.content.includes("t3 "), true);
  assert.equal(
    plan.recent.some((message) => message.content.includes("[Acciones: acc 2]")),
    true,
  );
});

test("lo que ya no cabe pasa a una memoria corta, sin el texto nuevo", () => {
  const plan = planContext(talk(9, 20), null);
  assert.equal(plan.fold, null);
  assert.ok(plan.next);
  assert.equal(plan.recent[0]?.role, "user");
  assert.ok(plan.recent.length <= RECENT_TURNS);
  const visible = plan.recent.map((message) => message.content).join("\n");
  assert.equal(visible.includes("t1 "), false);
  assert.equal(visible.includes("t9 "), true);
  assert.equal(plan.next.text.includes("t1 "), true);
  assert.equal(plan.next.text.includes("t9 "), false);
  assert.equal(plan.next.text.includes("[Acciones:"), true);
});

test("la memoria ya hecha no se reescribe en el mensaje siguiente", () => {
  const first = planContext(talk(9, 20), null);
  assert.ok(first.next);
  const again = planContext(talk(9, 20), first.next);
  assert.equal(again.fold, null);
  assert.deepEqual(again.next, first.next);
});

test("un turno que sale de la ventana se añade a la memoria", () => {
  const first = planContext(talk(9, 20), null);
  assert.ok(first.next);
  const later = planContext(talk(15, 20), first.next);
  assert.equal(later.fold, null);
  assert.ok(later.next);
  assert.notEqual(later.next.untilId, first.next.untilId);
  assert.equal(later.next.text.includes("t1 "), true);
  assert.equal(later.next.text.includes("t15 "), false);
  assert.equal(later.recent.at(-1)?.content.includes("t15 "), true);
});

test("cuando la memoria se llena se pide un resumen, y después solo viaja ese resumen", () => {
  const rawTurns = talk(30, 400);
  const raw = rawTurns.reduce((sum, turn) => sum + turn.content.length, 0);
  const packed = planContext(rawTurns, null);
  assert.ok(packed.fold);
  assert.equal(packed.next, null);
  assert.equal(packed.fold.digest.includes("t1 "), true);
  assert.equal(packed.fold.digest.includes("t30 "), false);
  assert.ok(packed.fold.digest.length <= FOLD_CHARS);
  assert.equal(packed.recent.at(-1)?.content.includes("t30 "), true);

  const memory = { text: "x".repeat(80), untilId: packed.fold.untilId };
  const steady = planContext(rawTurns, memory);
  assert.equal(steady.fold, null);
  assert.equal(steady.next?.text, memory.text);
  const sent =
    steady.recent.reduce((sum, message) => sum + message.content.length, 0) + memory.text.length;
  assert.ok(sent * 2 < raw);
});

test("un turno con error no entra en el contexto", () => {
  const turns = talk(4, 20);
  turns.splice(1, 0, { id: "bad", role: "assistant", content: "SECRETO-ERROR", error: "falló" });
  assert.equal(JSON.stringify(planContext(turns, null)).includes("SECRETO-ERROR"), false);
});

test("la pregunta nueva se conserva aunque sea muy larga", () => {
  const turns = talk(2, 20);
  turns[1] = { id: "nueva", role: "user", content: "Q".repeat(20_000) };
  const plan = planContext(turns, null);
  const last = plan.recent.at(-1);
  assert.ok(last);
  assert.equal(last.content.startsWith("Q"), true);
  assert.ok(last.content.length <= LATEST_USER_CHARS + 1);
});

test("el resumen se recorta y se marca al enviarlo", () => {
  const long = `inicio\n${"m".repeat(MEMORY_CHARS + 400)}\nfinal`;
  const clipped = clipSummary(long);
  assert.ok(clipped.length <= MEMORY_CHARS);
  assert.equal(clipped.endsWith("…"), true);
  assert.equal(clipped.startsWith("inicio"), true);

  const fallback = fallbackMemory("previo", "m".repeat(MEMORY_CHARS));
  assert.ok(fallback.length <= MEMORY_CHARS);
  assert.equal(fallback.startsWith("previo"), true);

  assert.deepEqual(withMemory("  ", [{ role: "user", content: "hola" }]), [
    { role: "user", content: "hola" },
  ]);
  const marked = withMemory("hechos", [{ role: "user", content: "sigue" }]);
  assert.equal(marked[0]?.content.startsWith(MEMORY_MARK), true);
  assert.equal(marked[1]?.content, "sigue");

  const request = summaryRequest("previo", "Persona: hola");
  assert.equal(request.includes(String(MEMORY_CHARS)), true);
  assert.equal(request.includes("previo"), true);
  assert.equal(request.includes("Persona: hola"), true);
});
