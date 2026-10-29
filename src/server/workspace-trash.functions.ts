import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { canWrite, shareForUser } from "@/server/share";
import { subtree } from "@/server/space";
import { deleteDoc, getDoc, listTrash, purgeTrash, restoreFromTrash, VaultError } from "@/server/vault";
import { workspaces } from "@/server/workspace";

/**
 * Eliminar en un portafolio compartido con permiso de edición (va a la
 * papelera de su dueño) y la papelera de los espacios de trabajo: la ven,
 * recuperan y vacían sus administradores (y el administrador del sistema),
 * cada uno la de los espacios que administra. Ver `TrashBoard`.
 */

const id = z.string().min(1).max(80);
const SPACE_MANAGE = "space.manage";

async function context(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, profile, sysadmin: allows(profile, SPACE_MANAGE) };
}

/** Los espacios de trabajo que `userId` administra: los suyos como administrador, o todos para el del sistema. */
async function administered(userId: string) {
  const ctx = await context(userId);
  const rows = await workspaces(ctx.sql);
  const orgs = await ctx.sql<{ id: string; name: string }>`select id, name from app_org`;
  const out: { shareId: string; ownerId: string; name: string }[] = [];
  for (const row of rows) {
    const mine = ctx.sysadmin || (await shareForUser(ctx.sql, userId, row.share_id))?.access === "admin";
    if (mine) out.push({ shareId: row.share_id, ownerId: row.owner_id, name: orgs.find((org) => org.id === row.org_id)?.name ?? "" });
  }
  return { ...ctx, list: out.sort((a, b) => a.name.localeCompare(b.name)) };
}

export const myWorkspaceTrashes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context: auth }) => {
    const { list } = await administered(auth.userId);
    return list.map(({ shareId, name }) => ({ shareId, name }));
  });

async function ownerFor(userId: string, shareId: string) {
  const ctx = await administered(userId);
  const found = ctx.list.find((item) => item.shareId === shareId);
  return found ? { ...ctx, ownerId: found.ownerId } : null;
}

export const workspaceTrashList = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ shareId: id }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const ctx = await ownerFor(auth.userId, data.shareId);
    if (!ctx) return { ok: false as const, items: [] };
    return { ok: true as const, items: await listTrash(ctx.sql, ctx.ownerId) };
  });

export const workspaceTrashRestore = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ shareId: id, id }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const ctx = await ownerFor(auth.userId, data.shareId);
    if (!ctx) return { ok: false as const, error: "Solo los administradores del espacio de trabajo pueden recuperar." };
    try {
      const doc = await restoreFromTrash(ctx.sql, ctx.ownerId, data.id, ctx.profile.displayName || ctx.profile.loginName);
      return { ok: true as const, id: doc.id };
    } catch (error) {
      if (error instanceof VaultError) return { ok: false as const, error: error.message };
      throw error;
    }
  });

export const workspaceTrashPurge = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ shareId: id, ids: z.array(id).max(2000).optional() }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const ctx = await ownerFor(auth.userId, data.shareId);
    if (!ctx) return { ok: false as const, error: "Solo los administradores del espacio de trabajo pueden vaciar su papelera." };
    await purgeTrash(ctx.sql, ctx.ownerId, data.ids);
    return { ok: true as const };
  });

/** Manda a la papelera (del dueño) un documento de un portafolio compartido con permiso de edición. */
export const deleteSharedDoc = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ shareId: id, docId: id }).parse(input))
  .handler(async ({ context: auth, data }) => {
    const { sql, profile } = await context(auth.userId);
    const share = await shareForUser(sql, auth.userId, data.shareId);
    if (!share || share.kind !== "portfolio" || !canWrite(share.access)) return { ok: false as const, error: "No puedes eliminar aquí." };
    const doc = await getDoc(sql, share.ownerId, data.docId);
    if (!doc?.portfolioId || !(await subtree(sql, share.ownerId, share.targetId)).includes(doc.portfolioId)) {
      return { ok: false as const, error: "Ese documento no es parte de lo compartido." };
    }
    const needed = doc.kind === "file" ? PERMISSION.filesDelete : PERMISSION.notesDelete;
    if (!allows(profile, needed)) return { ok: false as const, error: "Tu rol no puede eliminar esto." };
    await deleteDoc(sql, share.ownerId, data.docId);
    return { ok: true as const };
  });
