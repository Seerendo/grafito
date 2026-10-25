import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { allowedSessionTtl } from "@/domain/session";
import { relationalEngine } from "@/server/platform";
import { assertLease, requireLease, revokeAll, revokeUser, writeTtl } from "@/server/lease";
import { readPermissionGrants, readUserProfile, allows } from "@/server/profile";
import { redisSpace } from "@/server/redis";
import { elasticDisk } from "@/server/search";
import { minioSpace } from "@/server/storage";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sessionPulse = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const lease = await assertLease(sql, context.userId);
    if (!lease.ok) return { ok: false as const };
    const grants = await readPermissionGrants(sql, context.userId);
    return { ok: true as const, expiresAt: lease.expiresAt, ...grants };
  });

export const revokeOwnLease = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await revokeUser(sql, context.userId);
    return { ok: true as const };
  });

export const setSessionTtl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ seconds: z.number().int() }).parse(input))
  .handler(async ({ context, data }) => {
    if (!allowedSessionTtl(data.seconds)) return { ok: false as const };
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "session.manage")) return { ok: false as const };
    await writeTtl(sql, data.seconds);
    await revokeAll(sql);
    return { ok: true as const };
  });

export const accountState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    return profile;
  });

export const updateAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(80),
        contactEmail: z.string().trim().max(120),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    if (data.contactEmail && !emailPattern.test(data.contactEmail)) {
      return { ok: false as const, error: "El correo no es válido." };
    }
    const sql = await requireLease(context.userId);
    const email = data.contactEmail || null;
    await sql`update "user" set name = ${data.name}, "updatedAt" = now() where id = ${context.userId}`;
    await sql`
      insert into app_profile (user_id, contact_email)
      values (${context.userId}, ${email})
      on conflict (user_id) do update set contact_email = ${email}
    `;
    return { ok: true as const, displayName: data.name, contactEmail: data.contactEmail };
  });

export const storageReport = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "admin.access")) return { ok: false as const, stores: [] };
    const stores: {
      id: string;
      label: string;
      total: number | null;
      available: number | null;
      used: number | null;
    }[] = [];
    try {
      const rows = await sql<{ bytes: number }>`select pg_database_size(current_database())::bigint as bytes`;
      const used = Number(rows[0]?.bytes);
      const disk = relationalEngine() === "pglite" ? await localVolume() : null;
      stores.push({
        id: "postgres",
        label: relationalEngine() === "postgres" ? "Postgres" : "Postgres embebido",
        total: disk?.total ?? null,
        available: disk?.available ?? null,
        used: Number.isFinite(used) ? used : null,
      });
    } catch {
      /* the relational source is down */
    }
    const [elastic, redis, files] = await Promise.all([elasticDisk(), redisSpace(), minioSpace()]);
    if (elastic) stores.push({ id: "elastic", label: "Elasticsearch", ...elastic });
    if (redis) stores.push({ id: "redis", label: "Redis", ...redis });
    if (files) stores.push({ id: "minio", label: "MinIO", ...files });
    return { ok: true as const, stores };
  });

async function localVolume(): Promise<{ total: number; available: number } | null> {
  try {
    const { statfsSync } = await import("node:fs");
    const stat = statfsSync(".data/pglite");
    const block = Number(stat.bsize);
    const total = Number(stat.blocks) * block;
    const available = Number(stat.bavail) * block;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, available };
  } catch {
    return null;
  }
}

