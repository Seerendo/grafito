/**
 * Deshacer y rehacer del editor de notas. El del navegador no sirve: el
 * cuadro de texto lo controla React, y cada cambio hecho por código (negrita,
 * enlaces, `[[…]]`, lo que llega al sincronizar) le borra o desordena su
 * historial, así que Ctrl+Z deshacía otra cosa y el texto quedaba descuadrado
 * con su coloreado. Aquí se guardan estados completos (texto y selección):
 * lo escrito seguido se agrupa en un solo paso, y cada cambio por código es un
 * paso propio. Sin `@/` en los imports: se prueba con `node --test`.
 */

export type TextState = { value: string; start: number; end: number };

export type UndoHistory = {
  past: TextState[];
  future: TextState[];
  /** Cuándo fue el último cambio al escribir, para agrupar lo escrito seguido. */
  typedAt: number;
};

/** Lo escrito con menos de esto entre tecla y tecla va en el mismo paso. */
export const GROUP_MS = 1000;
const MAX_STEPS = 200;

export function emptyHistory(): UndoHistory {
  return { past: [], future: [], typedAt: 0 };
}

/**
 * Antes de cambiar el texto: guarda cómo estaba (`before`). Al escribir
 * (`typing`), si el paso anterior también fue escribir y hace poco, no se
 * guarda otro: todo eso se deshace de una vez. También empieza paso nuevo al
 * pasar a otra línea.
 */
export function record(history: UndoHistory, before: TextState, after: string, typing: boolean, now = Date.now()): UndoHistory {
  if (before.value === after) return history;
  const newLine = after.length > before.value.length && after.slice(before.start, before.start + (after.length - before.value.length)).includes("\n");
  const grouped = typing && !newLine && history.typedAt > 0 && now - history.typedAt < GROUP_MS;
  const past = grouped ? history.past : [...history.past, before].slice(-MAX_STEPS);
  return { past, future: [], typedAt: typing ? now : 0 };
}

/** Deshacer: el estado anterior, o `null` si no hay. `current` pasa a poder rehacerse. */
export function undo(history: UndoHistory, current: TextState): { history: UndoHistory; state: TextState } | null {
  const state = history.past.at(-1);
  if (!state) return null;
  return { history: { past: history.past.slice(0, -1), future: [...history.future, current], typedAt: 0 }, state };
}

export function redo(history: UndoHistory, current: TextState): { history: UndoHistory; state: TextState } | null {
  const state = history.future.at(-1);
  if (!state) return null;
  return { history: { past: [...history.past, current], future: history.future.slice(0, -1), typedAt: 0 }, state };
}
