/** Cuánto dura un permiso o un enlace. `date` es el final de ese día (UTC). */

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
