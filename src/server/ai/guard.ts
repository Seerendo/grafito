import type { ChatMessage } from "./types.ts";

/**
 * Salvaguardas del asistente (sin `@/` en los imports: se prueban con
 * `node --test`). Ver `agent.ts`.
 */

/** Herramientas que crean o cambian algo en la bóveda. */
export const WRITE_TOOLS = new Set(["create_note", "update_note", "create_portfolio"]);

/**
 * Lo que caben los resultados de herramientas de este turno (caracteres). Al
 * pasarse, los más antiguos se acortan: un modelo con poco contexto (Ollama,
 * LM Studio) recortaba si no por el principio y perdía las instrucciones y
 * las herramientas.
 */
const TOOL_BUDGET = 40_000;
const KEEP_RECENT_TOOLS = 2;
const SHORT_TOOL = 600;

/**
 * Frases en las que el modelo dice que ya creó, editó o guardó algo. Si las
 * dice sin haber usado con éxito una herramienta que escribe, se le pide que
 * lo haga de verdad o que corrija la respuesta (ver `runAgent`). Sin `\b`, que
 * en JavaScript no reconoce letras con tilde; «creé» y no «cree», que también
 * es «¿quieres que cree…?».
 */
export const CLAIMS_WRITE =
  /(?<!\p{L})(creé|he creado|edité|he editado|actualicé|he actualizado|añadí|he añadido|guardé|he guardado|renombré|he renombrado|(?:está|están|quedó|quedaron|fue|fueron|ha sido|han sido)\s+(?:cread|guardad|actualizad|editad|añadid|renombrad)[oa]s?|i(?:'ve| have)? (?:created|updated|added|saved|renamed|edited)|(?:has been|have been|was|were) (?:created|updated|added|saved|renamed))(?!\p{L})/iu;

/** Los resultados viejos de herramientas, recortados si el turno se pasa de `TOOL_BUDGET`. */
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
