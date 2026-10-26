import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, diffStats } from "./diff.ts";

/** Diferencias por líneas del historial de versiones. */

test("textos iguales: todo igual", () => {
  const lines = diffLines("a\nb\nc", "a\nb\nc");
  assert.deepEqual(diffStats(lines), { added: 0, removed: 0 });
  assert.equal(lines.length, 3);
});

test("una línea cambiada en el medio", () => {
  const lines = diffLines("# Título\nuno\ndos\ntres", "# Título\nuno\nDOS\ntres");
  assert.deepEqual(
    lines.map((line) => `${line.kind[0]}${line.text}`),
    ["s# Título", "suno", "rdos", "aDOS", "stres"],
  );
});

test("añadir al final y quitar al principio", () => {
  const lines = diffLines("x\na\nb", "a\nb\nc");
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
  assert.deepEqual(lines[0], { kind: "removed", text: "x" });
  assert.deepEqual(lines.at(-1), { kind: "added", text: "c" });
});

test("desde vacío", () => {
  assert.deepEqual(diffStats(diffLines("", "a\nb")), { added: 2, removed: 1 });
});

test("texto enorme distinto: no se cuelga y marca todo", () => {
  const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join("\n");
  const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join("\n");
  assert.deepEqual(diffStats(diffLines(before, after)), { added: 3000, removed: 3000 });
});
