import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { signToken } from "@/server/file-links";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { VaultError } from "@/server/vault";
import { planExport } from "@/server/export";

/**
 * Enlace firmado para descargar un portafolio entero (o toda la bóveda) como
 * .zip: lleva lo que el rol puede exportar (notas, archivos) y caduca en unos
 * minutos. Ver `routes/api/portfolios/$id.download.ts`.
 */

const TTL_SECONDS = 5 * 60;

export type ZipTicket = { kind: "zip"; ownerId: string; portfolioId: string; notes: boolean; files: boolean };

export const portfolioZipLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ portfolioId: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    const allow = { notes: allows(profile, PERMISSION.notesExport), files: allows(profile, PERMISSION.filesDownload) };
    if (!allow.notes && !allow.files) return { ok: false as const, error: "Tu rol no puede descargar." };
    try {
      const plan = await planExport(sql, context.userId, data.portfolioId, allow);
      if (plan.entries.length === 0) return { ok: false as const, error: "No hay nada que descargar." };
    } catch (error) {
      if (error instanceof VaultError) return { ok: false as const, error: error.message };
      throw error;
    }
    const ticket: ZipTicket = { kind: "zip", ownerId: context.userId, portfolioId: data.portfolioId, ...allow };
    const { token } = signToken(ticket, TTL_SECONDS);
    return { ok: true as const, url: `/api/portfolios/${encodeURIComponent(data.portfolioId)}/download?t=${token}` };
  });
