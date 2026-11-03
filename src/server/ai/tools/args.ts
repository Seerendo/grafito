/** Parse model arguments supplied as text. */

export function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value);
}

/** cells is JSON text because the tool schema does not support nested objects. */
export function namedCells(args: Record<string, unknown>): Record<string, unknown> | null {
  const raw = args.cells;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}
