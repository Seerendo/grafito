import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { clamavEndpoint, parseClamavConfig } from "@/domain/clamav";
import { authMiddleware } from "@/lib/auth/middleware";
import { logActivity } from "@/server/audit";
import { pingEndpoint, probeClamd, readClamavSettings, writeClamavSettings } from "@/server/clamav";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";

/** Security administration requires security.manage. */

const form = z.object({
  enabled: z.boolean(),
  host: z.string().max(253),
  port: z.number().int(),
  timeoutSeconds: z.number().int(),
});

async function manager(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, profile, allowed: allows(profile, "security.manage") };
}

export const clamavAdminState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const };
    const settings = await readClamavSettings(sql);
    const status = await probeClamd(sql);
    return { ok: true as const, settings, status };
  });

export const saveClamavSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => form.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const, error: "Sin permiso." };
    const parsed = parseClamavConfig(data);
    if (!parsed.ok) return { ok: false as const, error: parsed.error };
    await writeClamavSettings(sql, parsed.config);
    await logActivity(sql, {
      actorId: context.userId,
      actorName: profile.loginName || profile.displayName,
      area: "Seguridad",
      message: parsed.config.enabled
        ? `Activa el antivirus en ${parsed.config.host}:${parsed.config.port}`
        : "Apaga el antivirus",
    });
    return { ok: true as const, settings: { ...parsed.config, source: "saved" as const } };
  });

/** Probe clamd with unsaved form settings. */
export const probeClamav = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => form.omit({ enabled: true, timeoutSeconds: true }).parse(input))
  .handler(async ({ context, data }) => {
    const { allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const, error: "Sin permiso.", status: "down" as const };
    const parsed = parseClamavConfig({ ...data, enabled: true, timeoutSeconds: 60 });
    if (!parsed.ok) return { ok: false as const, error: parsed.error, status: "down" as const };
    const status = await pingEndpoint(clamavEndpoint(parsed.config));
    return { ok: true as const, status };
  });
