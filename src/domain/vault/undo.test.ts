import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyHistory, GROUP_MS, record, redo, undo } from "./undo.ts";

/** Deshacer y rehacer del editor de notas. */

const at = (value: string, cursor = value.length) => ({ value, start: cursor, end: cursor });

test("lo escrito seguido se deshace de una vez", () => {
  let history = emptyHistory();
  history = record(history, at(""), "h", true, 1000);
  history = record(history, at("h"), "ho", true, 1100);
  history = record(history, at("ho"), "hol", true, 1200);
  const step = undo(history, at("hol"));
  assert.equal(step?.state.value, "");
  assert.equal(undo(step!.history, step!.state), null);
});

test("una pausa o una línea nueva empiezan otro paso", () => {
  let history = emptyHistory();
  history = record(history, at(""), "a", true, 1000);
  history = record(history, at("a"), "ab", true, 1000 + GROUP_MS + 1);
  history = record(history, at("ab"), "ab\n", true, 1000 + GROUP_MS + 50);
  const first = undo(history, at("ab\n"))!;
  assert.equal(first.state.value, "ab");
  const second = undo(first.history, first.state)!;
  assert.equal(second.state.value, "a");
});

test("un cambio por código (negrita) es un paso propio, y se puede rehacer", () => {
  let history = emptyHistory();
  history = record(history, at(""), "hola", true, 1000);
  history = record(history, { value: "hola", start: 0, end: 4 }, "**hola**", false, 1100);
  const back = undo(history, at("**hola**"))!;
  assert.deepEqual(back.state, { value: "hola", start: 0, end: 4 });
  const again = redo(back.history, back.state)!;
  assert.equal(again.state.value, "**hola**");
});

test("escribir después de deshacer descarta lo que se podía rehacer", () => {
  let history = emptyHistory();
  history = record(history, at(""), "uno", false, 1000);
  const back = undo(history, at("uno"))!;
  const after = record(back.history, back.state, "dos", false, 2000);
  assert.equal(redo(after, at("dos")), null);
});
