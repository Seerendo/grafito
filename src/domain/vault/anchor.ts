/**
 * Ancla de texto dentro de un archivo (un PDF): la frase exacta que se
 * seleccionó, en qué página, y unas letras de antes y de después para
 * distinguirla si se repite (como `TextQuoteSelector` de las anotaciones web).
 * Así un vínculo apunta a «EXP-7781» en la página 3 y no a todo el archivo.
 */

export type TextAnchor = { page: number; exact: string; prefix: string; suffix: string };

/** Letras de contexto que se guardan a cada lado. */
const CONTEXT = 32;
/** Tope de la frase vinculada. */
export const MAX_EXACT = 300;

/** El ancla del tramo `[start, end)` del texto de una página; `null` si está vacío. */
export function anchorAt(pageText: string, page: number, start: number, end: number): TextAnchor | null {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(pageText.length, Math.max(start, end));
  let a = from;
  let b = to;
  while (a < b && /\s/.test(pageText[a]!)) a += 1;
  while (b > a && /\s/.test(pageText[b - 1]!)) b -= 1;
  if (a === b) return null;
  b = Math.min(b, a + MAX_EXACT);
  return {
    page,
    exact: pageText.slice(a, b),
    prefix: pageText.slice(Math.max(0, a - CONTEXT), a),
    suffix: pageText.slice(b, b + CONTEXT),
  };
}

function commonSuffix(x: string, y: string): number {
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(x: string, y: string): number {
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

/**
 * Dónde está el ancla en el texto de su página: de las apariciones de la
 * frase, la que mejor coincide con lo de antes y lo de después. `null` si la
 * frase ya no está (el archivo cambió).
 */
export function locate(pageText: string, anchor: TextAnchor): { start: number; end: number } | null {
  if (!anchor.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (let at = pageText.indexOf(anchor.exact); at >= 0; at = pageText.indexOf(anchor.exact, at + 1)) {
    const before = pageText.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = pageText.slice(at + anchor.exact.length, at + anchor.exact.length + anchor.suffix.length);
    const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    if (!best || score > best.score) best = { start: at, score };
  }
  return best ? { start: best.start, end: best.start + anchor.exact.length } : null;
}

/** Clave de un vínculo: el destino y, si lo tiene, su ancla. */
export function linkKey(link: { targetId: string; anchor?: TextAnchor }): string {
  const anchor = link.anchor;
  return anchor ? `${link.targetId}#${anchor.page}:${anchor.prefix}\u0000${anchor.exact}\u0000${anchor.suffix}` : link.targetId;
}

/** Si un valor guardado es un ancla válida (al leer cachés y lo que llega al servidor). */
export function isTextAnchor(value: unknown): value is TextAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Partial<TextAnchor>;
  return (
    typeof anchor.page === "number" &&
    Number.isInteger(anchor.page) &&
    anchor.page >= 1 &&
    typeof anchor.exact === "string" &&
    anchor.exact.length > 0 &&
    anchor.exact.length <= MAX_EXACT &&
    typeof anchor.prefix === "string" &&
    typeof anchor.suffix === "string"
  );
}
