import assert from "node:assert/strict";
import test from "node:test";
import { isLatexName, latexTemplate } from "../../../src/domain/vault/latex.ts";
import { ocrCandidate } from "../../../src/domain/vault/ocr.ts";

/** LaTeX documents and which files go to OCR. */

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

test("al OCR van PDF e imágenes, no lo demás", () => {
  assert.equal(ocrCandidate("escaneo.pdf", "application/octet-stream"), true);
  assert.equal(ocrCandidate("foto", "image/jpeg"), true);
  assert.equal(ocrCandidate("plano.TIFF", ""), true);
  assert.equal(ocrCandidate("dibujo.svg", "image/svg+xml"), false);
  assert.equal(
    ocrCandidate(
      "acta.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    false,
  );
});
