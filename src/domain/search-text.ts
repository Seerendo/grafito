/**
 * Bounded search-index text and match excerpts without models. Per-document limits keep
 * indexing viable on small machines.
 */

/** Indexed content character limit per document. */
export const INDEX_CAP = 24_000;

/** Remove null bytes unsupported by Postgres and Elasticsearch text. */
function stripNuls(value: string): string {
  const nul = String.fromCharCode(0);
  return value.includes(nul) ? value.split(nul).join("") : value;
}

/** Combine parts and truncate to the limit. */
export function indexBody(parts: readonly string[]): string {
  const text = parts
    .map((part) => stripNuls(part).trim())
    .filter(Boolean)
    .join("\n");
  return text.length > INDEX_CAP ? text.slice(0, INDEX_CAP) : text;
}

/** One phrase occurrence with surrounding document text. */
export type Passage = { before: string; match: string; after: string };

const PASSAGE_RADIUS = 36;
const PASSAGE_LIMIT = 20;

function collapse(value: string): string {
  return stripNuls(value).replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the complete phrase case-insensitively, allowing whitespace variation. */
function phrasePattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.join(" ").length < 2) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");
}

/** Return every full-phrase occurrence with context. Individual matching words alone do not qualify. */
export function findPassages(
  body: string,
  query: string,
  radius = PASSAGE_RADIUS,
  limit = PASSAGE_LIMIT,
): { items: Passage[]; more: number } {
  const pattern = phrasePattern(query);
  if (!pattern) return { items: [], more: 0 };
  const hay = collapse(body);
  const items: Passage[] = [];
  let count = 0;
  for (const match of hay.matchAll(pattern)) {
    if (!match[0]) continue;
    count += 1;
    if (items.length >= limit) continue;
    const at = match.index ?? 0;
    const start = Math.max(0, at - radius);
    const end = Math.min(hay.length, at + match[0].length + radius);
    items.push({
      before: `${start > 0 ? "…" : ""}${hay.slice(start, at)}`,
      match: match[0],
      after: `${hay.slice(at + match[0].length, end)}${end < hay.length ? "…" : ""}`,
    });
  }
  return { items, more: Math.max(0, count - items.length) };
}

/** First occurrence on one line; empty when the phrase is absent. */
export function snippet(body: string, query: string, radius = 90): string {
  const first = findPassages(body, query, radius, 1).items[0];
  return first ? `${first.before}${first.match}${first.after}` : "";
}

/** Split text into spans for bolding every phrase occurrence. */
export function markSpans(text: string, query: string): { text: string; mark: boolean }[] {
  const pattern = phrasePattern(query);
  if (!pattern) return [{ text, mark: false }];
  const spans: { text: string; mark: boolean }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (!match[0] || at < cursor) continue;
    if (at > cursor) spans.push({ text: text.slice(cursor, at), mark: false });
    spans.push({ text: match[0], mark: true });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), mark: false });
  return spans.length > 0 ? spans : [{ text, mark: false }];
}

/** Search-bar filtering requires the exact phrase in item text; approximate matches are insufficient. */
export function exactPhraseFilter(value: string, search: string, keywords: string[] = []): number {
  const needle = collapse(search).toLowerCase();
  if (!needle) return 1;
  const hay = collapse(`${value} ${keywords.join(" ")}`).toLowerCase();
  return hay.includes(needle) ? 1 : 0;
}

/**
 * Exclude indexed results already matching title or visible local text, preventing duplicate
 * search entries.
 */
export function hitsBeyondTitle<T extends { id: string }>(
  hits: readonly T[],
  local: readonly { id: string; title: string; extra?: string }[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  return hits.filter((hit) => {
    const known = local.find((item) => item.id === hit.id);
    if (!known) return true;
    return !`${known.title} ${known.extra ?? ""}`.toLowerCase().includes(needle);
  });
}
