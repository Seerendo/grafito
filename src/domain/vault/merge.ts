/**
 * Three-way line merge from a common base. Accept one-sided edits; conflicting changes to the
 * same lines require user resolution rather than automatic merging. See server/vault.ts and
 * editSharedDoc.
 */

export type MergeResult = { ok: true; text: string } | { ok: false };

/** Maximum LCS matrix size, approximately four million cells. */
const MAX_CELLS = 4_000_000;

/** Map each line of a to its increasing LCS match in b, or minus one when unmatched. */
function matches(a: string[], b: string[]): Int32Array | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // lcs[i][j] is the common-subsequence length of the remaining suffixes.
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
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

const same = (x: string[], y: string[]) =>
  x.length === y.length && x.every((line, index) => line === y[index]);

/**
 * For same-size edited blocks, merge line by line; conflict only when both sides change one
 * line differently.
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
    // Next base line preserved in both versions.
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
