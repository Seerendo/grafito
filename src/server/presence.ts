/**
 * Process-local editing presence expires after TTL_MS without heartbeats. Redis presence is
 * shared across replicas. Relative imports enable direct tests.
 */

export const TTL_MS = 30_000;

type Entry = { name: string; at: number };

const globalRef = globalThis as typeof globalThis & {
  __grafitoPresence__?: Map<string, Map<string, Entry>>;
};

function notes(): Map<string, Map<string, Entry>> {
  globalRef.__grafitoPresence__ ??= new Map();
  return globalRef.__grafitoPresence__;
}

/** Register or remove userId's presence for ownerId/docId and return other editors' names. */
export function touchPresence(
  input: { ownerId: string; docId: string; userId: string; name: string; editing: boolean },
  now = Date.now(),
): string[] {
  const key = `${input.ownerId}:${input.docId}`;
  const all = notes();
  const people = all.get(key) ?? new Map<string, Entry>();
  if (input.editing) people.set(input.userId, { name: input.name, at: now });
  else people.delete(input.userId);
  for (const [id, entry] of people) if (now - entry.at > TTL_MS) people.delete(id);
  if (people.size === 0) all.delete(key);
  else all.set(key, people);
  return [...people.entries()].filter(([id]) => id !== input.userId).map(([, entry]) => entry.name);
}
