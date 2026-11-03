import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { readIndexStatus, requestReindex, startContentIndex } from "@/server/index/run";

/** Estado de la indexación de contenido. Monitorización → Indexación. */
export const indexStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "monitor.view")) return { ok: false as const };
    startContentIndex();
    return { ok: true as const, ...(await readIndexStatus(sql)) };
  });

/** Vuelve a indexar todos los documentos, en segundo plano. */
export const reindexContent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "monitor.view")) return { ok: false as const };
    await requestReindex(sql);
    startContentIndex();
    return { ok: true as const };
  });
