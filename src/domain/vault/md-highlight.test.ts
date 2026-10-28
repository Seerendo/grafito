import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightMarkdown } from "./md-highlight.ts";

/** El coloreado nunca cambia el texto, y reconoce los tipos de Markdown. */

const kinds = (line: string) => highlightMarkdown(line)[0]!.map((span) => `${span.token}:${span.text}`);

test("la suma de los tramos es el texto original", () => {
  const source = "# Título\n\n- [ ] tarea con **negrita** y [[Nota]]\n> [!idea] Llamado\n```js\nconst a = 1;\n```\n| a | b |\ntexto_con_guiones y #etiqueta https://x.com/a";
  const joined = highlightMarkdown(source)
    .map((spans) => spans.map((span) => span.text).join(""))
    .join("\n");
  assert.equal(joined, source);
});

test("bloques", () => {
  assert.deepEqual(kinds("## Hola"), ["mark:##", "heading: Hola"]);
  assert.deepEqual(kinds("- [x] hecho"), ["list:-", "text: ", "task:[x]", "text: hecho"]);
  assert.deepEqual(kinds("> [!idea] Ojo"), ["quote:> ", "callout:[!idea]", "text: Ojo"]);
  assert.deepEqual(kinds("---"), ["hr:---"]);
  const fenced = highlightMarkdown("```\n# no es título\n```");
  assert.deepEqual(fenced.map((line) => line.map((span) => span.token)), [["fence"], ["code"], ["fence"]]);
});

test("en línea", () => {
  assert.deepEqual(kinds("ver [[Nota]] y `x` y **b** e *i*"), [
    "text:ver ",
    "wiki:[[Nota]]",
    "text: y ",
    "inline-code:`x`",
    "text: y ",
    "strong:**b**",
    "text: e ",
    "em:*i*",
  ]);
  assert.deepEqual(kinds("nombre_con_guiones #tag"), ["text:nombre_con_guiones ", "tag:#tag"]);
  assert.deepEqual(kinds("[sitio](https://a.b)"), ["link:[sitio](https://a.b)"]);
});
