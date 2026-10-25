import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import {
  openByToken,
  openForUser,
  ownerShares,
  shareCandidates,
  shareOrgCandidates,
  sharedWith,
  writePublished,
  writeShare,
} from "@/server/share";

/** Funciones de servidor para compartir en solo lectura (ver `server/share.ts`). */

const id = z.string().min(1).max(80);

/** ~1,5 MB por archivo en data URL: el límite de subida (~700 KB) con margen. */
const MAX_FILE_DATA = 1_500_000;

const publishedDoc = z.object({
  id,
  title: z.string().max(200),
  kind: z.enum(["markdown", "file"]),
  portfolioId: id.nullable(),
  content: z.string().max(400_000),
  file: z.object({ name: z.string().max(200), mime: z.string().max(120), dataUrl: z.string().max(MAX_FILE_DATA) }).nullable(),
  updatedBy: z.string().max(80),
  updatedAt: z.string().max(40),
});

const publishedPortfolio = z.object({ id, name: z.string().max(120), parentId: id.nullable() });

async function sharer(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, canShare: allows(profile, PERMISSION.notesShare) };
}

/** Elementos que el usuario compartió, con sus invitados. */
export const myShares = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    return ownerShares(sql, context.userId);
  });

/** Usuarios con quienes se puede compartir. */
export const shareUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, canShare } = await sharer(context.userId);
    if (!canShare) return [];
    return shareCandidates(sql, context.userId);
  });

/** Organizaciones con las que se puede compartir. */
export const shareOrgs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, canShare } = await sharer(context.userId);
    if (!canShare) return [];
    return shareOrgCandidates(sql);
  });

/** Cambia la visibilidad de una nota o portafolio propio. */
export const setShare = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        kind: z.enum(["document", "portfolio"]),
        targetId: id,
        title: z.string().max(200),
        visibility: z.enum(["private", "shared", "public"]),
        userIds: z.array(id).max(200),
        orgIds: z.array(id).max(200).default([]),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, canShare } = await sharer(context.userId);
    if (!canShare) return { ok: false as const, error: "Tu rol no permite compartir." };
    if (data.visibility === "shared" && data.userIds.length === 0 && data.orgIds.length === 0) {
      return { ok: false as const, error: "Elige al menos un usuario u organización." };
    }
    await writeShare(sql, context.userId, data);
    return { ok: true as const, shares: await ownerShares(sql, context.userId) };
  });

/** Publica la copia de solo lectura de lo que el dueño tiene compartido. */
export const publishShared = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        documentIds: z.array(id).max(5000),
        portfolios: z.array(publishedPortfolio).max(2000),
        documents: z.array(publishedDoc).max(500),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    await writePublished(sql, context.userId, data);
    return { ok: true as const, shares: await ownerShares(sql, context.userId) };
  });

/** Lo que otros usuarios compartieron conmigo. */
export const sharedWithMe = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    return sharedWith(sql, context.userId);
  });

/** Abre un elemento compartido conmigo (o propio). */
export const openShared = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ shareId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    return openForUser(sql, context.userId, data.shareId);
  });

/** Abre un elemento público por su enlace. No requiere sesión. */
export const openPublic = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ token: z.string().min(16).max(64) }).parse(input))
  .handler(async ({ data }) => {
    const { getSql } = await import("@/lib/db");
    return openByToken(await getSql(), data.token);
  });
