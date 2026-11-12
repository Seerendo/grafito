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
  "create_table",
  "delete_note",
  "delete_file",
  "delete_portfolio",
]);

/** Tools that move something to the trash. They run only after the person confirms. */
export const DELETE_TOOLS = new Set(["delete_note", "delete_file", "delete_portfolio"]);

const AUTO_CHECK = "(Comprobación automática";

/** A short yes after the assistant asked. "si puedes…" is a new request, not a confirmation. */
function isDeletionYes(value: string): boolean {
  const text = value.trim().replace(/[.!]+$/u, "");
  if (!text || text.length > 180) return false;
  if (/^si$/iu.test(text)) return true;
  // A letter boundary, not \b: í is not a word character, so "sí" would never match.
  return /^(sí|ok|okay|vale|dale|confirmo|confirmado|adelante|hazlo|bórralo|borralo|elimínalo|eliminalo|yes|yeah|yep|confirm|confirmed)(?!\p{L})/iu.test(
    text,
  );
}

/**
 * The assistant question the person just said yes to, when it asked about deleting. Null when
 * the latest person message is not a yes to such a question, including a delete tool in the same
 * turn as the request.
 */
export function deletionQuestion(messages: readonly ChatMessage[]): string | null {
  let userAt = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || message.content.startsWith(AUTO_CHECK)) continue;
    userAt = index;
    break;
  }
  if (userAt < 0 || !isDeletionYes(messages[userAt]!.content)) return null;
  for (let index = userAt - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content.trim();
    if (!text) continue;
    return /[?¿]/.test(text) && /elimin|borr|papelera|delete|trash/i.test(text) ? text : null;
  }
  return null;
}

export function deletionConfirmed(messages: readonly ChatMessage[]): boolean {
  return deletionQuestion(messages) !== null;
}

function folded(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("es").replace(/\s+/g, " ").trim();
}

/** A yes covers only what the question named: the delete target must appear in it. */
export function namedInQuestion(question: string, name: string): boolean {
  const target = folded(name);
  return target.length > 0 && folded(question).includes(target);
}

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
  /(?<!\p{L})(creé|he creado|edité|he editado|actualicé|he actualizado|añadí|he añadido|guardé|he guardado|renombré|he renombrado|vinculé|he vinculado|eliminé|he eliminado|borré|he borrado|(?:está|están|quedó|quedaron|fue|fueron|ha sido|han sido)\s+(?:cread|guardad|actualizad|editad|añadid|renombrad|vinculad|eliminad|borrad)[oa]s?|i(?:'ve| have)? (?:created|updated|added|saved|renamed|edited|linked|deleted|removed)|(?:has been|have been|was|were) (?:created|updated|added|saved|renamed|linked|deleted|removed))(?!\p{L})/iu;

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
