/**
 * Fallback repair for Mermaid flowchart labels with unquoted punctuation. Quote node and edge
 * labels only after the original diagram fails parsing, leaving valid diagrams untouched.
 */

/** Punctuation requiring quoted Mermaid labels. */
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
          // Rectangular node labels, excluding nested brackets, special shapes and already quoted labels.
          .replace(
            /(\b[\w-]+)\[(?![[(/\\"])([^\]\n"]*?)\](?!\])/g,
            (match, id: string, text: string) =>
              SPECIAL.test(text) ? `${id}[${quote(text)}]` : match,
          )
          // Diamond labels, excluding double-brace shapes.
          .replace(/(\b[\w-]+)\{(?![{"])([^}\n"]*?)\}(?!\})/g, (match, id: string, text: string) =>
            SPECIAL.test(text) ? `${id}{${quote(text)}}` : match,
          )
          // Arrow labels between vertical bars.
          .replace(/\|(?!")([^|\n"]+)\|/g, (match, text: string) =>
            SPECIAL.test(text) ? `|${quote(text)}|` : match,
          )
      );
    })
    .join("\n");
}
