/**
 * PDF text anchor with exact phrase, page and surrounding context to distinguish repeated
 * phrases, similar to TextQuoteSelector. Links target a specific phrase rather than the whole
 * file.
 */

export type TextAnchor = { page: number; exact: string; prefix: string; suffix: string };

/** Context characters retained on each side. */
const CONTEXT = 32;
/** Maximum linked phrase length. */
export const MAX_EXACT = 300;

/** Build an anchor for a page's half-open text interval; null for an empty selection. */
export function anchorAt(
  pageText: string,
  page: number,
  start: number,
  end: number,
): TextAnchor | null {
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

/** Find the phrase occurrence with the best surrounding-context match; null if file changes removed it. */
export function locate(
  pageText: string,
  anchor: TextAnchor,
): { start: number; end: number } | null {
  if (!anchor.exact) return null;
  let best: { start: number; score: number } | null = null;
  for (
    let at = pageText.indexOf(anchor.exact);
    at >= 0;
    at = pageText.indexOf(anchor.exact, at + 1)
  ) {
    const before = pageText.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = pageText.slice(
      at + anchor.exact.length,
      at + anchor.exact.length + anchor.suffix.length,
    );
    const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    if (!best || score > best.score) best = { start: at, score };
  }
  return best ? { start: best.start, end: best.start + anchor.exact.length } : null;
}

/** Link identity combines destination and optional anchor. */
export function linkKey(link: { targetId: string; anchor?: TextAnchor }): string {
  const anchor = link.anchor;
  return anchor
    ? `${link.targetId}#${anchor.page}:${anchor.prefix}\u0000${anchor.exact}\u0000${anchor.suffix}`
    : link.targetId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keep a match whose stored phrase would still fit an anchor. */
function limitedSpan(
  pageText: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (end <= start || end - start > MAX_EXACT) return null;
  if (!pageText.slice(start, end).trim()) return null;
  return { start, end };
}

function exactSpan(
  pageText: string,
  phrase: string,
  flags: string,
): { start: number; end: number } | null {
  const match = new RegExp(escapeRegExp(phrase), flags).exec(pageText);
  if (!match || match.index === undefined) return null;
  return limitedSpan(pageText, match.index, match.index + match[0].length);
}

/** Match tokens with optional whitespace so a line break or a missing space still hits. */
function flexibleSpan(
  pageText: string,
  phrase: string,
  flags: string,
): { start: number; end: number } | null {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(tokens.map(escapeRegExp).join("\\s*"), flags);
  for (const match of pageText.matchAll(pattern)) {
    const start = match.index ?? 0;
    const span = limitedSpan(pageText, start, start + match[0].length);
    if (span) return span;
  }
  return null;
}

/**
 * First occurrence of a phrase in one page. Prefer the exact characters, then flexible
 * whitespace, then the same two searches without case. The returned slice is the page's own
 * text, so the stored anchor keeps the PDF's casing and spacing.
 */
export function phraseSpan(
  pageText: string,
  phrase: string,
): { start: number; end: number } | null {
  const needle = phrase.trim();
  if (!needle || needle.length > MAX_EXACT) return null;
  const at = pageText.indexOf(needle);
  if (at >= 0) return limitedSpan(pageText, at, at + needle.length);
  return (
    flexibleSpan(pageText, needle, "gu") ??
    exactSpan(pageText, needle, "iu") ??
    flexibleSpan(pageText, needle, "giu")
  );
}

export type PhraseLocation =
  | { ok: true; anchor: TextAnchor }
  | { ok: false; error: "empty" | "too-long" | "no-text" | "missing" }
  | { ok: false; error: "bad-page"; page: number; total: number }
  | { ok: false; error: "missing-page"; page: number }
  | { ok: false; error: "ambiguous"; pages: number[] };

/**
 * Build an anchor for a phrase across PDF pages. A given page is the only page searched. Without
 * a page, one hit is linked and several pages are reported so the caller can choose.
 */
export function locatePhrase(
  pages: readonly { page: number; text: string }[],
  phrase: string,
  page?: number,
): PhraseLocation {
  const needle = phrase.trim();
  if (!needle) return { ok: false, error: "empty" };
  if (needle.length > MAX_EXACT) return { ok: false, error: "too-long" };
  if (!pages.some((item) => item.text.trim())) return { ok: false, error: "no-text" };
  const total = pages.reduce((max, item) => Math.max(max, item.page), 0);
  if (page !== undefined) {
    if (!Number.isInteger(page) || page < 1 || !pages.some((item) => item.page === page)) {
      return { ok: false, error: "bad-page", page, total };
    }
    const chosen = pages.find((item) => item.page === page)!;
    const span = phraseSpan(chosen.text, needle);
    const anchor = span ? anchorAt(chosen.text, page, span.start, span.end) : null;
    return anchor ? { ok: true, anchor } : { ok: false, error: "missing-page", page };
  }
  const hits: { page: number; text: string; span: { start: number; end: number } }[] = [];
  for (const item of pages) {
    const span = phraseSpan(item.text, needle);
    if (span) hits.push({ page: item.page, text: item.text, span });
  }
  const found = [...new Set(hits.map((hit) => hit.page))];
  if (found.length === 0) return { ok: false, error: "missing" };
  if (found.length > 1) return { ok: false, error: "ambiguous", pages: found };
  const hit = hits[0]!;
  const anchor = anchorAt(hit.text, hit.page, hit.span.start, hit.span.end);
  return anchor ? { ok: true, anchor } : { ok: false, error: "missing" };
}

/** Validate persisted anchors from caches and server requests. */
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
