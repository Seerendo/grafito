/**
 * Per-process public-form limits by address and form within one minute prevent unlimited
 * submissions/uploads. Effective limits multiply across replicas. Relative imports support Node
 * tests.
 */

const WINDOW_MS = 60_000;

export const LIMITS = {
  /** Submissions per address and form. */
  submitPerAddress: 5,
  /** Total submissions per form. */
  submitPerForm: 60,
  /** Uploads per address and form. */
  filePerAddress: 10,
} as const;

const hits = new Map<string, number[]>();

function take(key: string, max: number, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  // Prune stale addresses to bound map growth.
  if (hits.size > 20_000) {
    for (const [other, times] of hits)
      if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(other);
  }
  return true;
}

/** Whether another submission or file is allowed; false means retry later. */
export function allowPublicForm(
  kind: "submit" | "file",
  token: string,
  address: string,
  now = Date.now(),
): boolean {
  if (kind === "file") return take(`file:${token}:${address}`, LIMITS.filePerAddress, now);
  if (!take(`form:${token}`, LIMITS.submitPerForm, now)) return false;
  return take(`submit:${token}:${address}`, LIMITS.submitPerAddress, now);
}

/**
 * Use the final X-Forwarded-For address added by Grafito's gateway; earlier entries may be
 * client-controlled.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  return last || headers.get("x-real-ip") || "desconocida";
}

/** Test-only helper. */
export function resetFormLimits(): void {
  hits.clear();
}
