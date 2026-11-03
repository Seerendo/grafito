import type { RedisClientType } from "redis";

const PREFIX = "grafito:lease:";

type Client = RedisClientType;

let connecting: Promise<Client | null> | null = null;
let active: Client | null = null;

export function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

async function client(): Promise<Client | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (active?.isOpen) return active;
  if (!connecting) {
    connecting = (async () => {
      const { createClient } = await import("redis");
      const next = createClient({
        url,
        socket: { connectTimeout: 800, reconnectStrategy: false },
      });
      next.on("error", () => undefined);
      await next.connect();
      active = next;
      return next;
    })().catch(() => {
      active = null;
      return null;
    });
  }
  const current = await connecting;
  connecting = null;
  return current?.isOpen ? current : null;
}

export async function redisSetLease(userId: string, seconds: number): Promise<void> {
  const redis = await client();
  if (!redis) return;
  await redis.set(`${PREFIX}${userId}`, "1", { EX: Math.max(1, Math.floor(seconds)) });
}

export async function redisHasLease(userId: string): Promise<boolean | null> {
  const redis = await client();
  if (!redis) return null;
  const found = await redis.exists(`${PREFIX}${userId}`);
  return found === 1;
}

export async function redisDropLease(userId: string): Promise<void> {
  const redis = await client();
  if (!redis) return;
  await redis.del(`${PREFIX}${userId}`);
}

export async function redisDropAllLeases(): Promise<void> {
  const redis = await client();
  if (!redis) return;
  for await (const keys of redis.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 100 })) {
    if (keys.length > 0) await redis.del(keys);
  }
}

export async function redisMemoryBytes(): Promise<number | null> {
  const space = await redisSpace();
  return space?.used ?? null;
}

export async function redisSpace(): Promise<{
  total: number;
  available: number;
  used: number;
} | null> {
  if (!redisConfigured()) return null;
  try {
    const redis = await client();
    if (!redis) return null;
    const info = await redis.info("memory");
    const read = (key: string) => {
      const match = info.match(new RegExp(`${key}:(\\d+)`));
      return match ? Number(match[1]) : 0;
    };
    const used = read("used_memory");
    const limit = read("maxmemory");
    const system = read("total_system_memory");
    const total = limit > 0 ? limit : system;
    if (total <= 0) return null;
    return { total, used, available: Math.max(0, total - used) };
  } catch {
    return null;
  }
}

// Secret notes; see server/secret-note.ts.

const NOTE_PREFIX = "grafito:note:";

/** Store an expiring note; report whether Redis accepted it. */
export async function redisPutNote(id: string, sealed: string, seconds: number): Promise<boolean> {
  const redis = await client();
  if (!redis) return false;
  await redis.set(NOTE_PREFIX + id, sealed, { EX: Math.max(1, Math.ceil(seconds)) });
  return true;
}

/** Atomically read and delete a note to guarantee one-time access; null without Redis. */
export async function redisTakeNote(
  id: string,
): Promise<{ found: boolean; sealed: string | null } | null> {
  const redis = await client();
  if (!redis) return null;
  const sealed = await redis.getDel(NOTE_PREFIX + id);
  return { found: sealed !== null, sealed };
}

export async function redisDropNote(id: string): Promise<void> {
  const redis = await client();
  if (redis) await redis.del(NOTE_PREFIX + id);
}

const PRESENCE = "grafito:presence:";

/**
 * Cross-replica editing presence in one hash per note, storing editor names and heartbeat
 * timestamps. Return null without Redis; presence.ts provides the local fallback.
 */
export async function redisTouchPresence(
  input: { ownerId: string; docId: string; userId: string; name: string; editing: boolean },
  ttlMs: number,
  now = Date.now(),
): Promise<string[] | null> {
  const redis = await client();
  if (!redis) return null;
  const key = `${PRESENCE}${input.ownerId}:${input.docId}`;
  if (input.editing)
    await redis.hSet(key, input.userId, JSON.stringify({ name: input.name, at: now }));
  else await redis.hDel(key, input.userId);
  await redis.pExpire(key, ttlMs * 2);
  const all = await redis.hGetAll(key);
  const names: string[] = [];
  const stale: string[] = [];
  for (const [userId, raw] of Object.entries(all)) {
    try {
      const entry = JSON.parse(raw) as { name: string; at: number };
      if (now - entry.at > ttlMs) stale.push(userId);
      else if (userId !== input.userId) names.push(entry.name);
    } catch {
      stale.push(userId);
    }
  }
  if (stale.length > 0) await redis.hDel(key, stale);
  return names;
}

const TREE = "grafito:tree:";

/**
 * Shared-tree cache across replicas stores revision/build metadata and compressed base64 body
 * atomically per item/variant. Separate freshness timestamps avoid redundant rebuilding and
 * preserve consistent ETags. Return null without Redis.
 */
export type SharedTreeMeta = { revision: number; at: number };

export async function redisTreeState(
  key: string,
): Promise<{ meta: SharedTreeMeta | null; checkedAt: number | null } | null> {
  const redis = await client();
  if (!redis) return null;
  const [meta, checked] = await Promise.all([
    redis.hGet(`${TREE}${key}`, "meta"),
    redis.get(`${TREE}${key}:checked`),
  ]);
  return {
    meta: meta ? (JSON.parse(meta) as SharedTreeMeta) : null,
    checkedAt: checked ? Number(checked) : null,
  };
}

/** Return the compressed body only if the requested version is still current. */
export async function redisTreeBody(key: string, want: SharedTreeMeta): Promise<Buffer | null> {
  const redis = await client();
  if (!redis) return null;
  const [meta, gz] = await redis.hmGet(`${TREE}${key}`, ["meta", "gz"]);
  if (!meta || !gz) return null;
  const found = JSON.parse(meta) as SharedTreeMeta;
  return found.revision === want.revision && found.at === want.at
    ? Buffer.from(gz, "base64")
    : null;
}

export async function redisPutTree(
  key: string,
  meta: SharedTreeMeta,
  gzip: Buffer,
  ttlMs: number,
): Promise<void> {
  const redis = await client();
  if (!redis) return;
  await redis.hSet(`${TREE}${key}`, { meta: JSON.stringify(meta), gz: gzip.toString("base64") });
  await redis.pExpire(`${TREE}${key}`, ttlMs);
  await redis.set(`${TREE}${key}:checked`, String(meta.at), { PX: ttlMs });
}

export async function redisTreeChecked(key: string, at: number, ttlMs: number): Promise<void> {
  const redis = await client();
  if (!redis) return;
  await redis.set(`${TREE}${key}:checked`, String(at), { PX: ttlMs });
}
