/**
 * Mezcla de tres vías de una nota (por líneas), como `diff3`: dos personas
 * parten de la misma versión (`base`) y cada una guarda la suya. Lo que solo
 * cambió una se toma de ella; si las dos tocaron las mismas líneas (una borra
 * un párrafo que la otra está editando, por ejemplo) es un conflicto y no se
 * mezcla: decide la persona (ver `server/vault.ts` y `editSharedDoc`).
 */

export type MergeResult = { ok: true; text: string } | { ok: false };

/** Tope de líneas × líneas para el emparejamiento (unos 4 millones de celdas). */
const MAX_CELLS = 4_000_000;

/**
 * Para cada línea de `a`, la línea de `b` con la que se empareja en una
 * subsecuencia común más larga, o -1. Los emparejamientos son crecientes.
 */
function matches(a: string[], b: string[]): Int32Array | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // lcs[i][j]: longitud común de a[i..] y b[j..].
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const out = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out[i] = j;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) i += 1;
    else j += 1;
  }
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, index) => line === y[index]);

/**
 * Un bloque que las dos cambiaron línea por línea (sin añadir ni quitar):
 * dos puntos seguidos de una lista, por ejemplo. Se resuelve por líneas; solo
 * es conflicto si las dos cambiaron la misma línea de forma distinta.
 */
function lineByLine(o: string[], a: string[], b: string[]): string[] | null {
  if (a.length !== o.length || b.length !== o.length) return null;
  const out: string[] = [];
  for (let index = 0; index < o.length; index += 1) {
    if (a[index] === o[index] || a[index] === b[index]) out.push(b[index]!);
    else if (b[index] === o[index]) out.push(a[index]!);
    else return null;
  }
  return out;
}

export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs || theirs === base) return { ok: true, text: mine };
  if (mine === base) return { ok: true, text: theirs };
  const o = base.split("\n");
  const a = mine.split("\n");
  const b = theirs.split("\n");
  const toA = matches(o, a);
  const toB = matches(o, b);
  if (!toA || !toB) return { ok: false };

  const out: string[] = [];
  let i = 0;
  let ia = 0;
  let ib = 0;
  while (i <= o.length) {
    // Siguiente línea de la base que sigue en las dos versiones (estable).
    let k = i;
    while (k < o.length && (toA[k]! < ia || toB[k]! < ib)) k += 1;
    const endA = k < o.length ? toA[k]! : a.length;
    const endB = k < o.length ? toB[k]! : b.length;
    const chunkO = o.slice(i, k);
    const chunkA = a.slice(ia, endA);
    const chunkB = b.slice(ib, endB);
    if (chunkO.length + chunkA.length + chunkB.length > 0) {
      if (same(chunkA, chunkO)) out.push(...chunkB);
      else if (same(chunkB, chunkO) || same(chunkA, chunkB)) out.push(...chunkA);
      else {
        const lines = lineByLine(chunkO, chunkA, chunkB);
        if (!lines) return { ok: false };
        out.push(...lines);
      }
    }
    if (k >= o.length) break;
    out.push(o[k]!);
    i = k + 1;
    ia = endA + 1;
    ib = endB + 1;
  }
  return { ok: true, text: out.join("\n") };
}
