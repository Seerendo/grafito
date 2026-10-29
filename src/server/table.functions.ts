import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { FIELD_TYPES } from "@/domain/vault/table";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { editableTarget, grantedDocOwner } from "@/server/share";
import { addRows, deleteField, deleteRows, readTable, rowsSince, saveField, updateCell } from "@/server/table";

/**
 * Funciones de servidor de las tablas de datos (ver `server/table.ts`). Una
 * tabla propia la lee y cambia su dueño; una de lo compartido conmigo (o de un
 * espacio de trabajo), quien puede verla o editarla por ahí, igual que una
 * nota. Leer pide `notes.read`; cambiar, `notes.edit`.
 */

const id = z.string().min(1).max(80);
const where = z.object({ docId: id, shareId: id.optional() });

async function access(userId: string, input: { docId: string; shareId?: string }, write: boolean) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const actor = profile.displayName || profile.loginName;
  const mayRead = allows(profile, PERMISSION.notesRead);
  const mayEdit = allows(profile, PERMISSION.notesEdit);
  if (!mayRead || (write && !mayEdit)) return null;
  if (!input.shareId) return { sql, ownerId: userId, canEdit: mayEdit, actor };
  const editable = mayEdit ? await editableTarget(sql, userId, input.shareId, input.docId) : null;
  if (write) return editable ? { sql, ownerId: editable.ownerId, canEdit: true, actor } : null;
  const ownerId = editable?.ownerId ?? (await grantedDocOwner(sql, userId, input.shareId, input.docId));
  return ownerId ? { sql, ownerId, canEdit: Boolean(editable), actor } : null;
}

const denied = { ok: false as const, error: "No puedes cambiar esta tabla." };

export const tableOpen = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, false);
    if (!ctx) return { ok: false as const, error: "No puedes ver esta tabla." };
    const table = await readTable(ctx.sql, ctx.ownerId, data.docId, ctx.canEdit);
    return { ok: true as const, canEdit: ctx.canEdit, ...table };
  });

/** Lo que cambiaron los demás desde `since`. */
export const tableChanges = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ since: z.number() }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, false);
    if (!ctx) return { ok: false as const, error: "No puedes ver esta tabla." };
    return { ok: true as const, ...(await rowsSince(ctx.sql, ctx.ownerId, data.docId, data.since)) };
  });

export const tableSaveField = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    where
      .extend({
        field: z.object({
          id,
          name: z.string().max(120),
          type: z.enum(FIELD_TYPES),
          choices: z.array(z.string().max(120)).max(100).optional(),
          position: z.number().optional(),
          width: z.number().int().min(60).max(1200).nullable().optional(),
        }),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    return saveField(ctx.sql, ctx.ownerId, data.docId, data.field);
  });

export const tableDeleteField = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ fieldId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    await deleteField(ctx.sql, ctx.ownerId, data.docId, data.fieldId);
    return { ok: true as const };
  });

export const tableAddRows = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    where.extend({ rows: z.array(z.object({ cells: z.record(z.string(), z.unknown()) })).min(1).max(1000) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    return addRows(ctx.sql, ctx.ownerId, data.docId, data.rows, ctx.actor);
  });

export const tableUpdateCell = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ rowId: id, fieldId: id, value: z.unknown() }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    return updateCell(ctx.sql, ctx.ownerId, data.docId, data, ctx.actor);
  });

export const tableDeleteRows = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ rowIds: z.array(id).min(1).max(1000) }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    await deleteRows(ctx.sql, ctx.ownerId, data.docId, data.rowIds, ctx.actor);
    return { ok: true as const };
  });
