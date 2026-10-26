import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { MAX_CONTENT, pullChanges, pushChanges } from "@/server/vault";

/** Sincronización de la bóveda del navegador con la del servidor (ver `app/vault/sync.ts`). */

const id = z.string().min(1).max(80);

const docSchema = z.object({
  id,
  title: z.string().max(200),
  kind: z.enum(["markdown", "file"]),
  portfolioId: id.nullable(),
  content: z.string().max(MAX_CONTENT),
  // Los archivos nuevos solo traen su clave; `dataUrl` es de cachés antiguas y
  // de las notas de ejemplo, y el servidor lo pasa al almacén (server/files.ts).
  file: z
    .object({
      name: z.string().max(200),
      mime: z.string().max(120),
      key: z.string().max(200).optional(),
      size: z.number().int().min(0).optional(),
      dataUrl: z.string().max(1_500_000).optional(),
    })
    .nullable(),
  links: z.array(z.object({ targetId: id, kind: z.enum(["referencia", "llama"]) })).max(200),
  pinned: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.string().max(80),
  updatedBy: z.string().max(80),
});

const portfolioSchema = z.object({ id, name: z.string().max(120), parentId: id.nullable() });

/** Permisos de escritura: sin ninguno, el navegador no puede cambiar la bóveda del servidor. */
const WRITE = [
  PERMISSION.notesCreate,
  PERMISSION.notesEdit,
  PERMISSION.notesDelete,
  PERMISSION.filesUpload,
  PERMISSION.filesDelete,
  PERMISSION.portfoliosManage,
  PERMISSION.linksManage,
];

export const pushVault = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        docs: z.array(docSchema).max(500),
        deletedDocs: z.array(id).max(2000),
        portfolios: z.array(portfolioSchema).max(2000),
        deletedPortfolios: z.array(id).max(2000),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!WRITE.some((key) => allows(profile, key))) return { ok: false as const, error: "Tu rol no puede modificar la bóveda." };
    const canDelete = allows(profile, PERMISSION.notesDelete) || allows(profile, PERMISSION.filesDelete);
    if (data.deletedDocs.length > 0 && !canDelete) return { ok: false as const, error: "Tu rol no puede borrar." };
    if (data.deletedPortfolios.length > 0 && !allows(profile, PERMISSION.portfoliosManage)) {
      return { ok: false as const, error: "Tu rol no puede borrar portafolios." };
    }
    return { ok: true as const, revision: await pushChanges(sql, context.userId, data) };
  });

export const pullVault = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ since: z.number().int().min(0) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    return pullChanges(sql, context.userId, data.since);
  });
