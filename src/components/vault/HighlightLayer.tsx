import { forwardRef, memo } from "react";
import { highlightMarkdown } from "@/domain/vault/md-highlight";

/**
 * La nota coloreada (`md-highlight.ts`), debajo del cuadro de texto del
 * editor: el cuadro deja su texto transparente y esta capa, con la misma letra,
 * márgenes y ajuste de líneas, se desplaza con él. Así se conservan el cursor,
 * la selección, los atajos y el autocompletado del cuadro de texto.
 */
export const HighlightLayer = memo(
  forwardRef<HTMLPreElement, { source: string; className: string }>(function HighlightLayer({ source, className }, ref) {
    const lines = highlightMarkdown(source);
    return (
      <pre ref={ref} aria-hidden data-ui="md-highlight" className={className}>
        {lines.map((spans, index) => (
          <span key={index}>
            {spans.map((span, at) =>
              span.token === "text" ? span.text : (
                <span key={at} className={`md-${span.token}`}>
                  {span.text}
                </span>
              ),
            )}
            {index < lines.length - 1 ? "\n" : null}
          </span>
        ))}
        {/* Una línea más: el cuadro de texto deja sitio tras un salto final. */}
        {"\n "}
      </pre>
    );
  }),
);
