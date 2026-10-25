import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { createToken, listTokens, revokeToken } from "@/server/api-tokens";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";

/** Cuenta → API: tokens personales para la API REST. */

async function owner(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, ok: allows(profile, "api.use") };
}

export const myApiTokens = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ok } = await owner(context.userId);
    if (!ok) return { ok: false as const, tokens: [] };
    return { ok: true as const, tokens: await listTokens(sql, context.userId) };
  });

export const createApiToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ name: z.string().max(60) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await owner(context.userId);
    if (!ok) return { ok: false as const, error: "Tu rol no puede usar la API." };
    const created = await createToken(sql, context.userId, data.name);
    return { ok: true as const, ...created };
  });

export const revokeApiToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await owner(context.userId);
    if (!ok) return { ok: false as const };
    await revokeToken(sql, context.userId, data.id);
    return { ok: true as const };
  });
