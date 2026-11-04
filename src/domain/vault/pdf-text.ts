/**
 * Plain text of one PDF.js page. Item strings are concatenated and a newline is added where the
 * extractor marks the end of a line, matching the text the viewer searches. The DOM text layer
 * omits those newlines, so a phrase that stays on one line still matches either source.
 */

export function pagePlainText(items: readonly unknown[]): string {
  let text = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) continue;
    const piece = item as { str?: unknown; hasEOL?: unknown };
    if (typeof piece.str !== "string") continue;
    text += piece.str;
    if (piece.hasEOL) text += "\n";
  }
  return text;
}
