/**
 * Quién está editando una nota ahora mismo (solo servidor, en memoria). Cada
 * editor abierto avisa cada pocos segundos (`notePresence`); quien deja de
 * avisar desaparece a los `TTL_MS`. Vive en el proceso: con varias instancias
 * de Grafito, cada una ve a quienes avisan a ella. Sin `@/` en los imports:
 * se prueba con `node --test`.
 */

export const TTL_MS = 30_000;

type Entry = { name: string; at: number };

const globalRef = globalThis as typeof globalThis & { __grafitoPresence__?: Map<string, Map<string, Entry>> };

function notes(): Map<string, Map<string, Entry>> {
  globalRef.__grafitoPresence__ ??= new Map();
  return globalRef.__grafitoPresence__;
}

/**
 * Registra (o retira, con `editing: false`) a `userId` en la nota
 * `ownerId`/`docId` y devuelve los nombres de las demás personas que la
 * están editando.
 */
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
