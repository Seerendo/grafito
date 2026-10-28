import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorAt, isTextAnchor, linkKey, locate } from "./anchor.ts";

/** Vincular una frase de un PDF y volver a encontrarla. */

const page = "Expediente EXP-7781. La inspección fue favorable. Ver también el expediente EXP-7781 anexo.";

test("el ancla guarda la frase y su contexto, sin espacios sueltos", () => {
  const start = page.indexOf("EXP-7781");
  const anchor = anchorAt(page, 3, start - 1, start + 8);
  assert.deepEqual(anchor, { page: 3, exact: "EXP-7781", prefix: "Expediente ", suffix: ". La inspección fue favorable. V" });
  assert.equal(anchorAt(page, 1, 5, 5), null);
  assert.equal(anchorAt(page, 1, 10, 11), null);
});

test("encuentra la aparición correcta cuando la frase se repite", () => {
  const second = page.lastIndexOf("EXP-7781");
  const anchor = anchorAt(page, 1, second, second + 8)!;
  assert.deepEqual(locate(page, anchor), { start: second, end: second + 8 });
  const first = page.indexOf("EXP-7781");
  assert.deepEqual(locate(page, anchorAt(page, 1, first, first + 8)!), { start: first, end: first + 8 });
});

test("sigue encontrándola si cambió el texto de alrededor", () => {
  const anchor = anchorAt(page, 1, page.indexOf("favorable"), page.indexOf("favorable") + 9)!;
  const edited = `Nota previa. ${page.replace("La inspección", "La segunda inspección")}`;
  const found = locate(edited, anchor);
  assert.equal(found && edited.slice(found.start, found.end), "favorable");
});

test("si la frase ya no está, no la encuentra", () => {
  const anchor = anchorAt(page, 1, 0, 10)!;
  assert.equal(locate("Otro texto distinto.", anchor), null);
});

test("la clave distingue el mismo destino con y sin ancla", () => {
  const anchor = anchorAt(page, 2, 11, 19)!;
  assert.notEqual(linkKey({ targetId: "n1" }), linkKey({ targetId: "n1", anchor }));
  assert.equal(linkKey({ targetId: "n1", anchor }), linkKey({ targetId: "n1", anchor: { ...anchor } }));
});

test("valida anclas guardadas", () => {
  assert.ok(isTextAnchor({ page: 1, exact: "a", prefix: "", suffix: "" }));
  assert.ok(!isTextAnchor({ page: 0, exact: "a", prefix: "", suffix: "" }));
  assert.ok(!isTextAnchor({ page: 1, exact: "", prefix: "", suffix: "" }));
  assert.ok(!isTextAnchor(null));
});
