import assert from "node:assert/strict";
import { test } from "node:test";
import { isFlowchart, quoteFlowchartLabels } from "./mermaid-fix.ts";

/** Comillas en las etiquetas de un diagrama de flujo que las necesitan, y nada más. */

test("pone comillas en etiquetas con paréntesis, llaves o signos", () => {
  assert.equal(quoteFlowchartLabels("flowchart LR\n  A[Inicio (paso 1)] --> B"), 'flowchart LR\n  A["Inicio (paso 1)"] --> B');
  assert.equal(quoteFlowchartLabels("graph TD\n  B{¿Listo (ya)?} -->|Sí (1)| C"), 'graph TD\n  B{"¿Listo (ya)?"} -->|"Sí (1)"| C');
  assert.equal(quoteFlowchartLabels('flowchart LR\n  A[Dice "hola" (x)] --> B'), 'flowchart LR\n  A[Dice "hola" (x)] --> B');
});

test("no toca lo que ya está bien", () => {
  const ok = 'flowchart LR\n  A["Ya (bien)"] --> B[[Subrutina]]\n  C[(Base)] --> D((Círculo))\n  E{{Hex}} --> F[Normal]\n  classDef r fill:#f96\n  style A fill:#bbf';
  assert.equal(quoteFlowchartLabels(ok), ok);
  const sequence = "sequenceDiagram\n  A->>B: hola (x)";
  assert.equal(quoteFlowchartLabels(sequence), sequence);
});

test("reconoce un diagrama de flujo", () => {
  assert.equal(isFlowchart("%% nota\nflowchart LR\nA-->B"), true);
  assert.equal(isFlowchart("graph TD\nA-->B"), true);
  assert.equal(isFlowchart("sequenceDiagram"), false);
});
