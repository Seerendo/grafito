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

export async function redisSpace(): Promise<{ total: number; available: number; used: number } | null> {
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
