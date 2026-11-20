import assert from "node:assert/strict";
import test from "node:test";
import { isLatexName, latexTemplate } from "../../../src/domain/vault/latex.ts";

/** LaTeX documents. */

test("la plantilla es un documento completo con el título limpio", () => {
  const tex = latexTemplate("Informe {raro} $ & 50%");
  assert.ok(tex.startsWith("\\documentclass"));
  assert.ok(tex.includes("\\title{Informe raro   50}"), tex.split("\n")[8]);
  assert.ok(tex.includes("\\begin{document}"));
  assert.ok(tex.trimEnd().endsWith("\\end{document}"));
  assert.ok(latexTemplate("   ").includes("\\title{Documento}"));
});

test("se reconocen los .tex", () => {
  assert.equal(isLatexName("tesis.TEX"), true);
  assert.equal(isLatexName("tesis.tex.pdf"), false);
});
