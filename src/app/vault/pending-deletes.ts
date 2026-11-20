/**
 * Deletions made in this browser that the server has not confirmed yet. Synchronization sends
 * exactly these and nothing else: a document missing from the local cache is never taken as
 * deleted (a cache the browser could not save in full looked like hundreds of deletions).
 * Kept per user in a small localStorage entry, apart from the vault cache, so a reload still
 * sends them. `failed` is set when the last attempt to send them failed.
 */

export type PendingDeletes = {
  docs: Record<string, number>;
  portfolios: Record<string, number>;
  failed: boolean;
};

const PREFIX = "grafito.deletes:";

const cache = new Map<string, PendingDeletes>();
const listeners = new Set<() => void>();

function empty(): PendingDeletes {
  return { docs: {}, portfolios: {}, failed: false };
}

function load(userId: string): PendingDeletes {
  const hit = cache.get(userId);
  if (hit) return hit;
  let value = empty();
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFIX + userId);
    const parsed = raw ? (JSON.parse(raw) as Partial<PendingDeletes>) : null;
    if (parsed && typeof parsed === "object")
      value = {
        docs: parsed.docs && typeof parsed.docs === "object" ? parsed.docs : {},
        portfolios:
          parsed.portfolios && typeof parsed.portfolios === "object" ? parsed.portfolios : {},
        failed: parsed.failed === true,
      };
  } catch (error) {
    console.warn("[vault] pending deletions could not be read", error);
  }
  cache.set(userId, value);
  return value;
}

function save(userId: string, value: PendingDeletes): void {
  cache.set(userId, value);
  try {
    const none = Object.keys(value.docs).length === 0 && Object.keys(value.portfolios).length === 0;
    if (none) localStorage.removeItem(PREFIX + userId);
    else localStorage.setItem(PREFIX + userId, JSON.stringify(value));
  } catch (error) {
    // Still held in memory for this tab; a reload before the next synchronization loses them,
    // and the documents then come back from the server instead of being deleted.
    console.warn("[vault] pending deletions could not be saved", error);
  }
  for (const listener of listeners) listener();
}

export function pendingDeletes(userId: string): PendingDeletes {
  return load(userId);
}

export function recordDeletes(
  userId: string | null,
  docs: Iterable<string>,
  portfolios: Iterable<string> = [],
): void {
  if (!userId) return;
  const current = load(userId);
  const now = Date.now();
  const next: PendingDeletes = {
    docs: { ...current.docs },
    portfolios: { ...current.portfolios },
    failed: current.failed,
  };
  let changed = false;
  for (const id of docs) {
    next.docs[id] ??= now;
    changed = true;
  }
  for (const id of portfolios) {
    next.portfolios[id] ??= now;
    changed = true;
  }
  if (changed) save(userId, next);
}

/** The server took these: forget them. */
export function confirmDeletes(
  userId: string,
  sent: { docs: readonly string[]; portfolios: readonly string[] },
): void {
  const current = load(userId);
  const next: PendingDeletes = {
    docs: { ...current.docs },
    portfolios: { ...current.portfolios },
    failed: false,
  };
  for (const id of sent.docs) delete next.docs[id];
  for (const id of sent.portfolios) delete next.portfolios[id];
  save(userId, next);
}

/** Something came back (restored, or never deleted on the server): nothing to send for it. */
export function dropDeletes(userId: string, docs: Iterable<string>, portfolios: Iterable<string>) {
  const current = load(userId);
  let changed = false;
  const next: PendingDeletes = {
    docs: { ...current.docs },
    portfolios: { ...current.portfolios },
    failed: current.failed,
  };
  for (const id of docs)
    if (id in next.docs) {
      delete next.docs[id];
      changed = true;
    }
  for (const id of portfolios)
    if (id in next.portfolios) {
      delete next.portfolios[id];
      changed = true;
    }
  if (changed) save(userId, next);
}

export function markDeletesFailed(userId: string, failed: boolean): void {
  const current = load(userId);
  if (current.failed === failed) return;
  save(userId, { ...current, failed });
}

export function onPendingDeletes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
