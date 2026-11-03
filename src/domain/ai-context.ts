/**
 * Contexto que ve el modelo. El chat guarda la conversación entera; aquí se
 * comprime como en Grok o Claude: los turnos recientes van tal cual y lo
 * anterior cabe en una memoria corta. Cuando esa memoria se llena, el mismo
 * modelo la reescribe (`fold`) y el historial viejo no se vuelve a enviar.
 */

/** Turnos recientes que se mandan sin resumir. */
export const RECENT_TURNS = 8;
/** Tope de esos turnos, en caracteres. */
export const RECENT_CHARS = 6_000;
/** Tope de un turno reciente que no es la pregunta nueva. */
export const TURN_CHARS = 2_000;
/** Tope de la pregunta que se está enviando. */
export const LATEST_USER_CHARS = 12_000;
/** Tope de la memoria guardada y reenviada. */
export const MEMORY_CHARS = 1_500;
/** Tope de lo que se le pasa al modelo para reescribir la memoria. */
export const FOLD_CHARS = 8_000;

const DIGEST_LINE = 220;

export const MEMORY_MARK =
  "[Memoria de la conversación, comprimida por Grafito para no reenviar el historial. No es un mensaje de la persona.]";

export type ContextTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: { label: string }[];
  error?: string;
};

export type ContextMemory = { text: string; untilId: string };

export type ContextFold = { prior: string; digest: string; untilId: string };

export type ContextMessage = { role: "user" | "assistant"; content: string };

export type ContextPlan = {
  /** Turnos recientes, con las acciones de verdad. Empiezan por la persona. */
  recent: ContextMessage[];
  /**
   * Si viene, hay que reescribir la memoria con el modelo antes de responder.
   * `untilId` es el último turno ya incorporado.
   */
  fold: ContextFold | null;
  /**
   * Memoria lista para guardar. Vacía si toda la conversación cabe en
   * `recent`, o si hay que esperar el resumen de `fold`.
   */
  next: ContextMemory | null;
};

export function planContext(turns: ContextTurn[], memory: ContextMemory | null): ContextPlan {
  const usable = turns.filter((turn) => !turn.error && turn.content.trim());
  const recentTurns = takeRecent(usable);
  const older = usable.slice(0, usable.length - recentTurns.length);
  const recent = recentTurns.map((turn, index) => ({
    role: turn.role,
    content: renderTurn(
      turn,
      index === recentTurns.length - 1 && turn.role === "user" ? LATEST_USER_CHARS : TURN_CHARS,
    ),
  }));
  if (older.length === 0) return { recent, fold: null, next: null };

  const fresh = freshTurns(older, recentTurns, memory?.untilId);
  const prior = memory?.text.trim() ?? "";
  if (fresh.length === 0) {
    return prior && memory
      ? { recent, fold: null, next: { text: prior, untilId: memory.untilId } }
      : { recent, fold: null, next: null };
  }

  const digest = fresh.map(digestLine).join("\n");
  const untilId = fresh[fresh.length - 1]!.id;
  const combined = prior ? `${prior}\n${digest}` : digest;
  if (combined.length <= MEMORY_CHARS) return { recent, fold: null, next: { text: combined, untilId } };
  return { recent, fold: { prior, digest: capDigest(digest), untilId }, next: null };
}

/** Antepone la memoria al contexto. Sin memoria, deja los turnos como están. */
export function withMemory(memory: string, recent: ContextMessage[]): ContextMessage[] {
  const text = memory.trim();
  if (!text) return recent;
  return [{ role: "user", content: `${MEMORY_MARK}\n${text}` }, ...recent];
}

/** Recorta un resumen al tope, por el final de una línea si cabe. */
export function clipSummary(text: string): string {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= MEMORY_CHARS) return clean;
  const sliced = clean.slice(0, MEMORY_CHARS - 1).trimEnd();
  const line = sliced.lastIndexOf("\n");
  const cut = line > MEMORY_CHARS * 0.6 ? sliced.slice(0, line) : sliced;
  return `${cut}…`;
}

/** Lo que se guarda si el modelo no llega a resumir. */
export function fallbackMemory(prior: string, digest: string): string {
  return clipSummary([prior.trim(), digest.trim()].filter(Boolean).join("\n"));
}

/** Pide un resumen denso. El texto previo y los turnos nuevos ya vienen recortados. */
export function summaryRequest(prior: string, digest: string): string {
  const lines = [
    "Comprime la conversación en un resumen denso para seguir sin el historial completo.",
    "Conserva lo que la persona quiere, las decisiones, los nombres de notas y portafolios, lo creado o editado (solo si figura en Acciones) y lo que quedó pendiente.",
    "Quita saludos, repeticiones y el texto largo de las notas.",
    `Máximo ${MEMORY_CHARS} caracteres. Solo el resumen, en el idioma de la conversación, sin título.`,
  ];
  if (prior.trim()) lines.push("", "Resumen previo:", prior.trim());
  lines.push("", "Turnos que hay que incorporar:", digest.trim());
  return lines.join("\n");
}

function takeRecent(turns: ContextTurn[]): ContextTurn[] {
  const recent: ContextTurn[] = [];
  let size = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const latest = recent.length === 0;
    if (!latest && recent.length >= RECENT_TURNS) break;
    const prose =
      latest && turn.role === "user" ? Math.min(turn.content.length, LATEST_USER_CHARS) : Math.min(turn.content.length, TURN_CHARS);
    if (!latest && size + prose > RECENT_CHARS) break;
    recent.unshift(turn);
    size += prose;
  }
  while (recent.length > 1 && recent[0]?.role === "assistant") recent.shift();
  return recent;
}

function freshTurns(older: ContextTurn[], recent: ContextTurn[], untilId: string | undefined): ContextTurn[] {
  if (!untilId) return older;
  const covered = older.findIndex((turn) => turn.id === untilId);
  if (covered >= 0) return older.slice(covered + 1);
  if (recent.some((turn) => turn.id === untilId)) return [];
  return older;
}

function renderTurn(turn: ContextTurn, proseLimit: number): string {
  const prose = turn.content.trim();
  const body = prose.length > proseLimit ? `${prose.slice(0, proseLimit)}…` : prose;
  const actions =
    turn.role === "assistant" && turn.tools?.length
      ? `\n\n[Acciones: ${turn.tools.map((tool) => tool.label).join(" · ")}]`
      : "";
  return `${body}${actions}`;
}

function digestLine(turn: ContextTurn): string {
  const who = turn.role === "user" ? "Persona" : "Asistente";
  const actions =
    turn.role === "assistant" && turn.tools?.length ? ` [Acciones: ${turn.tools.map((tool) => tool.label).join(" · ")}]` : "";
  const text = `${turn.content.replace(/\s+/g, " ").trim()}${actions}`;
  const body = text.length > DIGEST_LINE ? `${text.slice(0, DIGEST_LINE - 1)}…` : text;
  return `${who}: ${body}`;
}

function capDigest(text: string): string {
  if (text.length <= FOLD_CHARS) return text;
  const head = Math.floor(FOLD_CHARS * 0.35);
  const tail = FOLD_CHARS - head - 20;
  return `${text.slice(0, head).trim()}\n…\n${text.slice(text.length - tail).trim()}`;
}
