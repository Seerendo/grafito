import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import {
  ownerShares,
  revokeShareLink,
  revokeShareSubject,
  shareActivity,
  shareCandidates,
  shareOrgCandidates,
  sharedDocText,
  sharedWith,
  writePublished,
  writeShare,
} from "@/server/share";

/** Funciones de servidor para compartir (ver `server/share.ts`). */

const id = z.string().min(1).max(80);

/** ~1,5 MB por archivo en data URL: el límite de subida (~700 KB) con margen. */
const MAX_FILE_DATA = 1_500_000;

const publishedDoc = z.object({
  id,
  title: z.string().max(200),
  kind: z.enum(["markdown", "file"]),
  portfolioId: id.nullable(),
  content: z.string().max(400_000),
  file: z
    .object({ name: z.string().max(200), mime: z.string().max(120), dataUrl: z.string().max(MAX_FILE_DATA).optional() })
    .nullable(),
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
        access: z.enum(["read", "edit", "admin"]).default("read"),
        userIds: z.array(id).max(200),
        orgIds: z.array(id).max(200).default([]),
        expiresAt: z.number().int().nullable().optional(),
        linkExpiresAt: z.number().int().nullable().optional(),
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

const target = z.object({ kind: z.enum(["document", "portfolio"]), targetId: id });

/** Quita a un invitado y guarda desde cuándo tenía permiso. */
export const revokeShareGrant = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.extend({ subjectKind: z.enum(["user", "org"]), subjectId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, canShare } = await sharer(context.userId);
    if (!canShare) return { ok: false as const, error: "Tu rol no permite compartir." };
    const done = await revokeShareSubject(sql, context.userId, data);
    if (!done) return { ok: false as const, error: "Ese permiso ya no está." };
    return { ok: true as const, shares: await ownerShares(sql, context.userId) };
  });

/** El enlace público deja de servir. Hay que crear otro para volver a abrirlo. */
export const revokePublicShare = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, canShare } = await sharer(context.userId);
    if (!canShare) return { ok: false as const, error: "Tu rol no permite compartir." };
    const done = await revokeShareLink(sql, context.userId, data);
    if (!done) return { ok: false as const, error: "No hay un enlace que revocar." };
    return { ok: true as const, shares: await ownerShares(sql, context.userId) };
  });

/** Periodos de permiso y últimas aperturas de un elemento propio. */
export const shareTrail = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, canShare } = await sharer(context.userId);
    if (!canShare) return { periods: [], events: [] };
    return shareActivity(sql, context.userId, data);
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

/** El texto de un documento de algo compartido conmigo, al abrirlo (el árbol no lo trae). */
export const sharedDocContent = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ shareId: id, docId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    return sharedDocText(sql, { userId: context.userId, shareId: data.shareId }, data.docId);
  });

/** Lo mismo por enlace público. No requiere sesión. */
export const publicDocContent = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ token: z.string().min(16).max(64), docId: id }).parse(input))
  .handler(async ({ data }) => {
    const { getSql } = await import("@/lib/db");
    return sharedDocText(await getSql(), { token: data.token }, data.docId);
  });

