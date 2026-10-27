import type { Sql } from "@/lib/db";
import { DEFAULT_SESSION_TTL } from "@/domain/session";
import { UnauthorizedError } from "@/lib/auth/verify.server";
import { redisDropAllLeases, redisDropLease, redisHasLease, redisSetLease } from "@/server/redis";

const MAX_TTL = 30 * 24 * 60 * 60;

export async function readTtl(sql: Sql): Promise<number> {
  const rows = await sql<{ value: string }>`select value from app_setting where key = 'session_ttl_seconds' limit 1`;
  const parsed = Number(rows[0]?.value);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_TTL;
  return Math.min(MAX_TTL, Math.max(60, Math.floor(parsed)));
}

export async function writeTtl(sql: Sql, seconds: number): Promise<void> {
  const value = String(seconds);
  await sql`
    insert into app_setting (key, value)
    values ('session_ttl_seconds', ${value})
    on conflict (key) do update set value = ${value}
  `;
}

async function liveSession(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from "session" where "userId" = ${userId} and "expiresAt" > now() limit 1
  `;
  return rows.length > 0;
}

export async function revokeUser(sql: Sql, userId: string): Promise<void> {
  await sql`delete from "session" where "userId" = ${userId}`;
  await sql`delete from app_lease where user_id = ${userId}`;
  await redisDropLease(userId);
}

export async function revokeAll(sql: Sql): Promise<void> {
  await sql`delete from "session"`;
  await sql`delete from app_lease`;
  await redisDropAllLeases();
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Sesión iniciada después de `since`: un ingreso nuevo tras vencer el plazo anterior. */
async function sessionSince(sql: Sql, userId: string, since: Date): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from "session"
    where "userId" = ${userId} and "createdAt" > ${since.toISOString()} and "expiresAt" > now()
    limit 1
  `;
  return rows.length > 0;
}

async function grantLease(sql: Sql, userId: string, ttl: number): Promise<{ ok: true; expiresAt: string }> {
  const expires = new Date(Date.now() + ttl * 1000);
  await sql`
    insert into app_lease (user_id, expires_at)
    values (${userId}, ${expires.toISOString()})
    on conflict (user_id) do update set expires_at = excluded.expires_at
  `;
  await redisSetLease(userId, ttl);
  return { ok: true, expiresAt: expires.toISOString() };
}

export async function assertLease(sql: Sql, userId: string): Promise<{ ok: true; expiresAt: string } | { ok: false }> {
  const ttl = await readTtl(sql);
  const rows = await sql<{ expires_at: unknown }>`
    select expires_at from app_lease where user_id = ${userId} limit 1
  `;
  const expiresAt = asDate(rows[0]?.expires_at);
  if (!expiresAt) {
    if (!(await liveSession(sql, userId))) return { ok: false };
    return grantLease(sql, userId, ttl);
  }
  if (expiresAt.getTime() <= Date.now()) {
    // Un plazo vencido no debe tumbar un ingreso posterior (p. ej. cerró el
    // navegador sin salir y volvió más tarde): se cierran solo las sesiones
    // anteriores al vencimiento y el ingreso nuevo recibe su propio plazo.
    if (await sessionSince(sql, userId, expiresAt)) {
      await sql`delete from "session" where "userId" = ${userId} and "createdAt" <= ${expiresAt.toISOString()}`;
      return grantLease(sql, userId, ttl);
    }
    await revokeUser(sql, userId);
    return { ok: false };
  }
  const remaining = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  const cached = await redisHasLease(userId);
  if (cached === false) await redisSetLease(userId, remaining);
  return { ok: true, expiresAt: expiresAt.toISOString() };
}

/** Cada cuánto se guarda la última conexión (no en cada petición). */
const SEEN_EVERY_MS = 60_000;
const seenAt = new Map<string, number>();

/**
 * Primer ingreso y última conexión (Administración → Usuarios). En memoria se
 * recuerda cuándo se escribió por última vez, para no escribir en cada petición.
 */
export async function markSeen(sql: Sql, userId: string): Promise<void> {
  const now = Date.now();
  if (now - (seenAt.get(userId) ?? 0) < SEEN_EVERY_MS) return;
  seenAt.set(userId, now);
  const at = new Date(now).toISOString();
  await sql`
    insert into app_profile (user_id, first_login_at, last_seen_at) values (${userId}, ${at}, ${at})
    on conflict (user_id) do update
      set last_seen_at = excluded.last_seen_at,
        first_login_at = coalesce(app_profile.first_login_at, excluded.first_login_at)
  `;
}

export async function requireLease(userId: string): Promise<Sql> {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const lease = await assertLease(sql, userId);
  if (!lease.ok) throw new UnauthorizedError();
  await markSeen(sql, userId).catch(() => undefined);
  // Envío periódico de avisos por correo (una vez por proceso).
  const { startNotifier } = await import("@/server/notify");
  startNotifier();
  return sql;
}
