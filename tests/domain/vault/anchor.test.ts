import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorAt,
  isTextAnchor,
  linkKey,
  locate,
  locatePhrase,
  phraseSpan,
} from "../../../src/domain/vault/anchor.ts";

/** Link a phrase in a PDF and find it again. */

const page =
  "Expediente EXP-7781. La inspección fue favorable. Ver también el expediente EXP-7781 anexo.";

test("el ancla guarda la frase y su contexto, sin espacios sueltos", () => {
  const start = page.indexOf("EXP-7781");
  const anchor = anchorAt(page, 3, start - 1, start + 8);
  assert.deepEqual(anchor, {
    page: 3,
    exact: "EXP-7781",
    prefix: "Expediente ",
    suffix: ". La inspección fue favorable. V",
  });
  assert.equal(anchorAt(page, 1, 5, 5), null);
  assert.equal(anchorAt(page, 1, 10, 11), null);
});

test("encuentra la aparición correcta cuando la frase se repite", () => {
  const second = page.lastIndexOf("EXP-7781");
  const anchor = anchorAt(page, 1, second, second + 8)!;
  assert.deepEqual(locate(page, anchor), { start: second, end: second + 8 });
  const first = page.indexOf("EXP-7781");
  assert.deepEqual(locate(page, anchorAt(page, 1, first, first + 8)!), {
    start: first,
    end: first + 8,
  });
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
  assert.equal(
    linkKey({ targetId: "n1", anchor }),
    linkKey({ targetId: "n1", anchor: { ...anchor } }),
  );
});

test("la frase exacta guarda el texto de la página", () => {
  const span = phraseSpan(page, "favorable")!;
  assert.equal(page.slice(span.start, span.end), "favorable");
  const located = locatePhrase([{ page: 2, text: page }], "favorable");
  assert.equal(located.ok, true);
  if (!located.ok) return;
  assert.equal(located.anchor.exact, "favorable");
  assert.equal(located.anchor.page, 2);
  assert.deepEqual(locate(page, located.anchor), span);
});

test("acepta un salto de línea o la falta de espacio y conserva el texto del PDF", () => {
  const broken = "La inspección\nfue favorable.";
  const span = phraseSpan(broken, "inspección fue")!;
  assert.equal(broken.slice(span.start, span.end), "inspección\nfue");
  const tight = phraseSpan("helloworld", "hello world")!;
  assert.equal("helloworld".slice(tight.start, tight.end), "helloworld");
  const cased = phraseSpan("Ver HELLO ahí", "hello")!;
  assert.equal("Ver HELLO ahí".slice(cased.start, cased.end), "HELLO");
});

test("sin página, una sola aparición se vincula y varias piden la página", () => {
  const pages = [
    { page: 1, text: "alpha al inicio" },
    { page: 2, text: "nada" },
    { page: 4, text: "otra alpha" },
  ];
  const ambiguous = locatePhrase(pages, "alpha");
  assert.deepEqual(ambiguous, { ok: false, error: "ambiguous", pages: [1, 4] });
  const chosen = locatePhrase(pages, "alpha", 4);
  assert.equal(chosen.ok, true);
  if (!chosen.ok) return;
  assert.equal(chosen.anchor.page, 4);
  assert.equal(chosen.anchor.exact, "alpha");
});

test("una página indicada no usa la frase de otra", () => {
  const pages = [
    { page: 1, text: "solo aquí" },
    { page: 2, text: "otra cosa" },
  ];
  assert.deepEqual(locatePhrase(pages, "solo aquí", 2), {
    ok: false,
    error: "missing-page",
    page: 2,
  });
  assert.deepEqual(locatePhrase(pages, "solo aquí", 9), {
    ok: false,
    error: "bad-page",
    page: 9,
    total: 2,
  });
  const only = locatePhrase([{ page: 3, text: "solo aquí" }], "solo aquí");
  assert.equal(only.ok && only.anchor.page, 3);
});

test("rechaza una frase vacía, una demasiado larga o un PDF sin texto", () => {
  const pages = [{ page: 1, text: "hola" }];
  assert.deepEqual(locatePhrase(pages, "   "), { ok: false, error: "empty" });
  assert.deepEqual(locatePhrase(pages, "a".repeat(301)), { ok: false, error: "too-long" });
  assert.deepEqual(locatePhrase([{ page: 1, text: "  \n" }], "hola"), {
    ok: false,
    error: "no-text",
  });
  assert.equal(phraseSpan("hola", "a".repeat(301)), null);
});

test("valida anclas guardadas", () => {
  assert.ok(isTextAnchor({ page: 1, exact: "a", prefix: "", suffix: "" }));
  assert.ok(!isTextAnchor({ page: 0, exact: "a", prefix: "", suffix: "" }));
  assert.ok(!isTextAnchor({ page: 1, exact: "", prefix: "", suffix: "" }));
  assert.ok(!isTextAnchor(null));
});
