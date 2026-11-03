import { forwardRef, memo } from "react";
import { highlightMarkdown } from "@/domain/vault/md-highlight";

/**
 * Markdown highlighting sits beneath a transparent textarea with matching typography and
 * scrolling, preserving native caret, selection, shortcuts and completion.
 */
export const HighlightLayer = memo(
  forwardRef<HTMLPreElement, { source: string; className: string }>(function HighlightLayer(
    { source, className },
    ref,
  ) {
    const lines = highlightMarkdown(source);
    return (
      <pre ref={ref} aria-hidden data-ui="md-highlight" className={className}>
        {lines.map((spans, index) => (
          <span key={index}>
            {spans.map((span, at) =>
              span.token === "text" ? (
                span.text
              ) : (
                <span key={at} className={`md-${span.token}`}>
                  {span.text}
                </span>
              ),
            )}
            {index < lines.length - 1 ? "\n" : null}
          </span>
        ))}
        {/* Add one line to match textarea space after a trailing newline. */}
        {"\n "}
      </pre>
    );
  }),
);
