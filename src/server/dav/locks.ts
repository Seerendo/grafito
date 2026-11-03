/**
 * Bloqueos WebDAV de este proceso (LOCK / UNLOCK). No se comparten entre
 * réplicas: cada una guarda los suyos. Caducan solos.
 */

type Lock = { token: string; until: number };

const locks = new Map<string, Lock>();

function keyOf(href: string): string {
  return href.replace(/\/+$/, "") || "/dav";
}

export function readLock(href: string, now = Date.now()): Lock | null {
  const key = keyOf(href);
  const lock = locks.get(key);
  if (!lock) return null;
  if (lock.until <= now) {
    locks.delete(key);
    return null;
  }
  return lock;
}

/** Crea o renueva. Si otra ficha lo tiene, no. */
export function takeLock(
  href: string,
  presented: string | null,
  seconds: number,
  now = Date.now(),
): { ok: true; token: string } | { ok: false } {
  const current = readLock(href, now);
  if (current && current.token !== presented) return { ok: false };
  if (current) {
    current.until = now + seconds * 1000;
    return { ok: true, token: current.token };
  }
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  locks.set(keyOf(href), { token, until: now + seconds * 1000 });
  return { ok: true, token };
}

export function dropLock(href: string, token: string | null): boolean {
  const current = readLock(href);
  if (!current || !token || current.token !== token) return false;
  locks.delete(keyOf(href));
  return true;
}

/** Hay un bloqueo y el cliente no trae su ficha. */
export function lockBlocks(href: string, presented: string | null): boolean {
  const current = readLock(href);
  return current !== null && current.token !== presented;
}
