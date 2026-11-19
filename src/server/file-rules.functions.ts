import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizeExtensions } from "@/domain/file-extensions";
import { authMiddleware } from "@/lib/auth/middleware";
import { logActivity } from "@/server/audit";
import { readExtensionRules, writeExtensionRules } from "@/server/file-rules";
import { requestReindex } from "@/server/index/run";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";

/** Uploaders read the rules to skip blocked files early; security.manage changes them. */
export const extensionRules = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    return readExtensionRules(sql);
  });

export const saveExtensionRules = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        upload: z.array(z.string().max(20)).max(500),
        index: z.array(z.string().max(20)).max(500),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "security.manage")) return { ok: false as const, error: "Sin permiso." };
    const before = await readExtensionRules(sql);
    const rules = {
      upload: normalizeExtensions(data.upload),
      index: normalizeExtensions(data.index),
    };
    await writeExtensionRules(sql, rules);
    // Index rules apply to stored documents too: reindex so they drop out or come back.
    if (before.index.join(",") !== rules.index.join(",")) await requestReindex(sql);
    await logActivity(sql, {
      actorId: context.userId,
      actorName: profile.loginName || profile.displayName,
      area: "Seguridad",
      message: `Extensiones bloqueadas: subida ${rules.upload.join(", ") || "ninguna"}; indexación ${rules.index.join(", ") || "ninguna"}`,
    });
    return { ok: true as const, rules };
  });
