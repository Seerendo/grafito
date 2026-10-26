import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import type { Sql } from "@/lib/db";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { listVersions, readVersion } from "@/server/history";
import { editableTarget } from "@/server/share";
import { getDoc, listTrash, MAX_CONTENT, purgeTrash, restoreFromTrash, updateNote, VaultError } from "@/server/vault";

/**
 * Historial de versiones, edición de lo compartido y papelera.
 *
 * Una nota propia se gestiona con el propio usuario como dueño. Con `shareId`,
 * se actúa sobre la nota de otro usuario que la compartió con permiso de
 * edición (`server/share.ts` → `editableTarget`).
 */

const id = z.string().min(1).max(80);

async function actorFor(sql: Sql, userId: string) {
  const profile = await readUserProfile(sql, userId);
  return { profile, actor: profile.displayName || "Alguien" };
}

/** Dueño de la nota sobre la que se actúa, o null si no hay acceso. */
async function ownerOf(sql: Sql, userId: string, docId: string, shareId?: string): Promise<string | null> {
  if (!shareId) return userId;
  return (await editableTarget(sql, userId, shareId, docId))?.ownerId ?? null;
}

const target = z.object({ docId: id, shareId: id.optional() });

export const docHistory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const ownerId = await ownerOf(sql, context.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, error: "No tienes acceso a esta nota." };
    return { ok: true as const, versions: await listVersions(sql, ownerId, data.docId) };
  });

export const docVersion = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.extend({ versionId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const ownerId = await ownerOf(sql, context.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, error: "No tienes acceso a esta nota." };
    const version = await readVersion(sql, ownerId, data.docId, data.versionId);
    return version ? { ok: true as const, version } : { ok: false as const, error: "Esa versión ya no existe." };
  });

export const restoreDocVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => target.extend({ versionId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const { profile, actor } = await actorFor(sql, context.userId);
    if (!allows(profile, PERMISSION.notesEdit)) return { ok: false as const, error: "Tu rol no puede editar notas." };
    const ownerId = await ownerOf(sql, context.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, error: "No tienes acceso a esta nota." };
    const version = await readVersion(sql, ownerId, data.docId, data.versionId);
    if (!version) return { ok: false as const, error: "Esa versión ya no existe." };
    try {
      const doc = await updateNote(sql, ownerId, data.docId, {
        title: version.title,
        content: version.content,
        actor,
        separateVersion: true,
      });
      return { ok: true as const, updatedAt: doc.updatedAt, title: doc.title, content: doc.content };
    } catch (error) {
      if (error instanceof VaultError) return { ok: false as const, error: error.message };
      throw error;
    }
  });

/**
 * Guarda una nota compartida conmigo con permiso de edición. Si cambió desde
 * que se abrió (`baseUpdatedAt`), no se pisa: se devuelve la versión actual.
 */
export const editSharedDoc = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        shareId: id,
        docId: id,
        title: z.string().max(200).optional(),
        content: z.string().max(MAX_CONTENT),
        baseUpdatedAt: z.number(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const { profile, actor } = await actorFor(sql, context.userId);
    if (!allows(profile, PERMISSION.notesEdit)) return { ok: false as const, error: "Tu rol no puede editar notas." };
    const ownerId = await ownerOf(sql, context.userId, data.docId, data.shareId);
    if (!ownerId) return { ok: false as const, error: "Ya no puedes editar esta nota." };
    const current = await getDoc(sql, ownerId, data.docId);
    if (!current || current.kind !== "markdown") return { ok: false as const, error: "Esta nota ya no existe." };
    if (current.updatedAt !== data.baseUpdatedAt) {
      return {
        ok: false as const,
        conflict: true as const,
        error: "La nota cambió mientras la editabas.",
        current: { title: current.title, content: current.content, updatedAt: current.updatedAt, updatedBy: current.updatedBy },
      };
    }
    try {
      const doc = await updateNote(sql, ownerId, data.docId, { title: data.title, content: data.content, actor });
      return { ok: true as const, title: doc.title, content: doc.content, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
    } catch (error) {
      if (error instanceof VaultError) return { ok: false as const, error: error.message };
      throw error;
    }
  });

// ---------------------------------------------------------------------------
// Papelera

export const trashList = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    return listTrash(sql, context.userId);
  });

export const trashRestore = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const { profile, actor } = await actorFor(sql, context.userId);
    if (!allows(profile, PERMISSION.notesCreate) && !allows(profile, PERMISSION.filesUpload)) {
      return { ok: false as const, error: "Tu rol no puede recuperar documentos." };
    }
    try {
      const doc = await restoreFromTrash(sql, context.userId, data.id, actor);
      return { ok: true as const, id: doc.id };
    } catch (error) {
      if (error instanceof VaultError) return { ok: false as const, error: error.message };
      throw error;
    }
  });

export const trashPurge = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ ids: z.array(id).max(2000).optional() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesDelete) && !allows(profile, PERMISSION.filesDelete)) {
      return { ok: false as const, error: "Tu rol no puede borrar." };
    }
    await purgeTrash(sql, context.userId, data.ids);
    return { ok: true as const };
  });
