import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { FIELD_TYPES, VIEW_MODES } from "@/domain/vault/table";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { deliverNotice } from "@/server/notify";
import { editableTarget, grantedDocOwner, shareCandidates, shareOrgCandidates } from "@/server/share";
import { addRows, attachFile, attachInvitedFile, attachPublicFile, deleteField, deleteRows, formActivity, invitedFormView, publicFormView, readTable, revokeFormLink, rowChoices, rowHistory, rowsSince, saveField, saveForm, saveLayout, submitInvitedForm, submitPublicForm, syncFormInvites, tableDigests, updateCell } from "@/server/table";

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
          relatedTableId: z.string().max(80).nullable().optional(),
          formula: z.string().max(500).nullable().optional(),
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

export const tableSaveLayout = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    where
      .extend({
        layout: z.object({
          mode: z.enum(VIEW_MODES),
          kanbanFieldId: z.string().max(80).nullable(),
          calendarFieldId: z.string().max(80).nullable(),
        }),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    return saveLayout(ctx.sql, ctx.ownerId, data.docId, data.layout);
  });

export const tableRowHistory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ rowId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, false);
    if (!ctx) return { ok: false as const, error: "No puedes ver esta tabla." };
    return { ok: true as const, history: await rowHistory(ctx.sql, ctx.ownerId, data.docId, data.rowId) };
  });

export const tableSaveForm = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    where
      .extend({
        title: z.string().max(160),
        description: z.string().max(4000),
        publish: z.boolean(),
        expiresAt: z.number().int().nullable().optional(),
        fields: z.array(z.object({ id, required: z.boolean() })).max(100),
        userIds: z.array(id).max(200).optional(),
        orgIds: z.array(id).max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    const saved = await saveForm(ctx.sql, ctx.ownerId, data.docId, data, ctx.actor);
    if (!saved.ok || (data.userIds === undefined && data.orgIds === undefined)) return saved;
    const synced = await syncFormInvites(ctx.sql, ctx.ownerId, data.docId, {
      userIds: data.userIds ?? [],
      orgIds: data.orgIds ?? [],
    });
    if (!synced) return saved;
    const quiet = { missing: [] as string[], mailed: 0, failed: 0, mailOff: false };
    const notice =
      synced.form.inviteToken && (synced.addedUserIds.length > 0 || synced.addedOrgIds.length > 0)
        ? await deliverNotice(ctx.sql, {
            actorId: context.userId,
            actorName: ctx.actor,
            title: synced.form.title,
            path: `/formularios/${synced.form.inviteToken}`,
            userIds: synced.addedUserIds,
            orgIds: synced.addedOrgIds,
            kind: "form",
          })
        : quiet;
    return { ok: true as const, form: synced.form, notice };
  });

/** Personas y organizaciones a las que se puede enviar el formulario. */
export const tableFormPeople = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return { users: [], orgs: [] };
    return { users: await shareCandidates(ctx.sql, context.userId), orgs: await shareOrgCandidates(ctx.sql) };
  });

export const tableRevokeForm = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    const form = await revokeFormLink(ctx.sql, ctx.ownerId, data.docId, ctx.actor);
    if (!form) return { ok: false as const, error: "No hay un enlace que revocar." };
    return { ok: true as const, form };
  });

export const tableFormActivity = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return { periods: [], events: [] };
    return formActivity(ctx.sql, ctx.ownerId, data.docId);
  });

export const tableRowChoices = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ tableId: id, query: z.string().max(120).optional() }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, false);
    if (!ctx) return { ok: false as const, error: "No puedes ver esta tabla." };
    return { ok: true as const, rows: await rowChoices(ctx.sql, ctx.ownerId, data.tableId, data.query ?? "") };
  });

export const tableAttach = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    where
      .extend({
        name: z.string().min(1).max(200),
        mime: z.string().max(120),
        key: z.string().min(1).max(300),
        size: z.number().int().min(0),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await access(context.userId, data, true);
    if (!ctx) return denied;
    const { mayUpload } = await import("@/server/upload-target");
    if (!(await mayUpload(ctx.sql, context.userId, data.key, data.shareId ?? null))) return { ok: false as const, error: "Ese archivo no es de esta bóveda." };
    return attachFile(ctx.sql, ctx.ownerId, data.docId, {
      name: data.name,
      mime: data.mime,
      key: data.key,
      size: data.size,
      actor: ctx.actor,
    });
  });

export const tableSearchTexts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    return { ok: true as const, text: await tableDigests(sql, context.userId) };
  });

const TOO_MANY = "Demasiados envíos seguidos. Espera un minuto y vuelve a intentarlo.";

/** Límite de envíos sin sesión (ver `form-limit.ts`). */
async function allowed(kind: "submit" | "file", token: string): Promise<boolean> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { allowPublicForm, clientAddress } = await import("@/server/form-limit");
  const request = getRequest();
  return allowPublicForm(kind, token, request ? clientAddress(request.headers) : "desconocida");
}

export const publicFormOpen = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ token: z.string().min(16).max(64) }).parse(input))
  .handler(async ({ data }) => {
    const { getSql } = await import("@/lib/db");
    return publicFormView(await getSql(), data.token);
  });

export const publicFormSubmit = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ token: z.string().min(16).max(64), cells: z.record(z.string(), z.unknown()) }).parse(input),
  )
  .handler(async ({ data }) => {
    if (!(await allowed("submit", data.token))) return { ok: false as const, error: TOO_MANY };
    const { getSql } = await import("@/lib/db");
    return submitPublicForm(await getSql(), data.token, data.cells);
  });

export const publicFormFile = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        token: z.string().min(16).max(64),
        name: z.string().min(1).max(200),
        mime: z.string().max(120),
        base64: z.string().max(8_000_000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    if (!(await allowed("file", data.token))) return { ok: false as const, error: TOO_MANY };
    const { getSql } = await import("@/lib/db");
    return attachPublicFile(await getSql(), data.token, data);
  });

const inviteToken = z.object({ token: z.string().min(16).max(64) });

export const invitedFormOpen = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => inviteToken.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    return invitedFormView(sql, data.token, context.userId);
  });

export const invitedFormSubmit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => inviteToken.extend({ cells: z.record(z.string(), z.unknown()) }).parse(input))
  .handler(async ({ context, data }) => {
    if (!(await allowed("submit", data.token))) return { ok: false as const, error: TOO_MANY };
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    return submitInvitedForm(sql, data.token, context.userId, profile.displayName || profile.loginName || "Alguien", data.cells);
  });

export const invitedFormFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    inviteToken
      .extend({
        name: z.string().min(1).max(200),
        mime: z.string().max(120),
        base64: z.string().max(8_000_000),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    if (!(await allowed("file", data.token))) return { ok: false as const, error: TOO_MANY };
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    return attachInvitedFile(sql, data.token, context.userId, profile.displayName || profile.loginName || "Alguien", data);
  });

