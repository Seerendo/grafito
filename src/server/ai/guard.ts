import type { ChatMessage } from "./types.ts";

/** Assistant safeguards with relative imports for direct Node tests; see agent.ts. */

/** Tools that create or modify vault content. */
export const WRITE_TOOLS = new Set([
  "create_note",
  "update_note",
  "create_portfolio",
  "add_table_row",
  "set_table_cell",
  "link_pdf_phrase",
]);

/**
 * Character budget for current-turn tool results. Clip older results first so small-context
 * models retain system instructions and tool definitions.
 */
const TOOL_BUDGET = 40_000;
const KEEP_RECENT_TOOLS = 2;
const SHORT_TOOL = 600;

/**
 * Detect claims of completed writes. Without a successful write tool, request execution or
 * correction. Unicode letter boundaries avoid JavaScript word-boundary issues with accented
 * Spanish verbs; distinguish completed creé from hypothetical cree.
 */
export const CLAIMS_WRITE =
  /(?<!\p{L})(creé|he creado|edité|he editado|actualicé|he actualizado|añadí|he añadido|guardé|he guardado|renombré|he renombrado|vinculé|he vinculado|(?:está|están|quedó|quedaron|fue|fueron|ha sido|han sido)\s+(?:cread|guardad|actualizad|editad|añadid|renombrad|vinculad)[oa]s?|i(?:'ve| have)? (?:created|updated|added|saved|renamed|edited|linked)|(?:has been|have been|was|were) (?:created|updated|added|saved|renamed|linked))(?!\p{L})/iu;

/** Clip older tool results when the turn exceeds TOOL_BUDGET. */
export function compactToolResults(messages: ChatMessage[]): void {
  const tools = messages.filter((message) => message.role === "tool");
  let total = tools.reduce((sum, message) => sum + message.content.length, 0);
  for (const message of tools.slice(0, -KEEP_RECENT_TOOLS)) {
    if (total <= TOOL_BUDGET) return;
    if (message.content.length <= SHORT_TOOL) continue;
    const short = `${message.content.slice(0, SHORT_TOOL)}… (resultado anterior recortado para ahorrar contexto; vuelve a pedirlo si lo necesitas)`;
    total -= message.content.length - short.length;
    message.content = short;
  }
}
