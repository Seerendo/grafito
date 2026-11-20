/**
 * Structured, low-cost events: one JSON line per event on stdout, for imports, synchronization,
 * file reads and the trash. Fields are ids, counts, sizes, durations and short status strings
 * only; never contents, file names, tokens or signed URLs.
 */

export type EventFields = Record<string, string | number | boolean | null | undefined>;

/** Correlation id of an import, sent by the browser with each request of one upload job. */
export const IMPORT_HEADER = "x-grafito-import";

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The import correlation id of a request, when it carries a well-formed one. */
export function importIdOf(request: Request): string | undefined {
  const value = request.headers.get(IMPORT_HEADER) ?? "";
  return ID.test(value) ? value : undefined;
}

export function logEvent(event: string, fields: EventFields = {}): void {
  const line: Record<string, string | number | boolean | null> = {
    at: new Date().toISOString(),
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  console.info(JSON.stringify(line));
}

/** Milliseconds since start, rounded. */
export function since(start: number): number {
  return Math.round(performance.now() - start);
}
