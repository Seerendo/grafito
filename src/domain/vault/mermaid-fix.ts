/**
 * Arreglo de los diagramas de flujo de Mermaid que fallan por algo muy común:
 * una etiqueta con paréntesis, llaves u otros signos sin comillas
 * (`A[Inicio (paso 1)] --> B`). Mermaid pide `A["Inicio (paso 1)"]`; aquí se
 * ponen esas comillas en las etiquetas de nodos (`[…]`, `{…}`) y de flechas
 * (`|…|`) que las necesitan. Solo se usa si el diagrama original no se pudo
 * leer, así que un diagrama correcto nunca cambia.
 */

/** Signos que Mermaid no acepta en una etiqueta sin comillas. */
const SPECIAL = /[(){}[\]<>;#&]/;

const quote = (text: string) => `"${text.replace(/"/g, "#quot;")}"`;

export function isFlowchart(chart: string): boolean {
  const first = chart
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%"));
  return /^(flowchart|graph)\b/i.test(first ?? "");
}

export function quoteFlowchartLabels(chart: string): string {
  if (!isFlowchart(chart)) return chart;
  return chart
    .split("\n")
    .map((line) => {
      if (/^\s*(%%|classDef|class|style|linkStyle|click)\b/.test(line)) return line;
      return (
        line
          // Nodo rectangular: id[texto] (no [[…]], [(…)], [/…/], ni ya entre comillas).
          .replace(/(\b[\w-]+)\[(?![[(/\\"])([^\]\n"]*?)\](?!\])/g, (match, id: string, text: string) =>
            SPECIAL.test(text) ? `${id}[${quote(text)}]` : match,
          )
          // Rombo: id{texto} (no {{…}}).
          .replace(/(\b[\w-]+)\{(?![{"])([^}\n"]*?)\}(?!\})/g, (match, id: string, text: string) =>
            SPECIAL.test(text) ? `${id}{${quote(text)}}` : match,
          )
          // Etiqueta de flecha: -->|texto|.
          .replace(/\|(?!")([^|\n"]+)\|/g, (match, text: string) => (SPECIAL.test(text) ? `|${quote(text)}|` : match))
      );
    })
    .join("\n");
}
