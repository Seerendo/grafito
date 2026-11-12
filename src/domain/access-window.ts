/** Grant or link duration. date expires at the end of that UTC day. */

export type ExpiryChoice = "never" | "1" | "7" | "30" | "90" | "date";

const DAY = 86_400_000;

export function expiryAt(choice: ExpiryChoice, date: string, now: number): number | null {
  if (choice === "never") return null;
  if (choice === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return null;
    const end = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
    return Number.isNaN(end) ? null : end;
  }
  const days = choice === "1" ? 1 : choice === "7" ? 7 : choice === "30" ? 30 : 90;
  return now + days * DAY;
}

/** YYYY-MM-DD of a timestamp in UTC, for the date input. */
export function utcDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Payload for saving. undefined preserves each grant's existing expiry when values differ and
 * the control was untouched.
 */
export function chosenExpiry(
  touched: boolean,
  mixed: boolean,
  mode: ExpiryChoice,
  date: string,
  existing: number | null,
  now = Date.now(),
): number | null | undefined {
  if (!touched) return mixed ? undefined : existing;
  return expiryAt(mode, date, now);
}
