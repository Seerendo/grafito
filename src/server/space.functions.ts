import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import type { Document } from "@/domain/vault/types";
import type { Sql } from "@/lib/db";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { blobSize } from "@/server/blobs";
import {
  canWrite,
  portfolioAccess,
  portfolioMembers,
  setGrantAccess,
  shareForUser,
  type ShareAccess,
} from "@/server/share";
import {
  checkShares,
  checkSpace,
  DEFAULT_USER_KEY,
  defaultUserLimit,
  memberLimits,
  portfolioLimit,
  portfolioUsage,
  subtree,
  userLimit,
} from "@/server/space";
import { mayUpload, uploadTarget } from "@/server/upload-target";
import { checkWorkspaceBytes, workspaceByOwner } from "@/server/workspace";
import { createNote, createPortfolio, getDoc, pushChanges, VaultError } from "@/server/vault";

/**
 * Espacio y permisos de un portafolio (ver `server/space.ts`):
 *  - el dueño, quien lo administra (acceso `admin`) y el administrador del
 *    sistema (`space.manage`) reparten su espacio entre los usuarios y
 *    cambian sus permisos;
 *  - el tope del portafolio y el de cada usuario en total los pone solo el
 *    administrador del sistema (Administración → Espacio).
 * Y añadir notas y archivos a un portafolio compartido con permiso de edición.
 */

const SPACE_MANAGE = "space.manage";
const id = z.string().min(1).max(80);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
/** Un portafolio propio, o uno compartido conmigo (`shareId`). */
const where = z.object({ portfolioId: id, shareId: id.optional() });

type Context = {
  sql: Sql;
  ownerId: string;
  portfolioId: string;
  /** Puede repartir el espacio y cambiar permisos. */
  canManage: boolean;
  /** Puede poner el tope del portafolio y los de cada usuario. */
  sysadmin: boolean;
};

async function portfolioContext(userId: string, input: { portfolioId: string; shareId?: string }): Promise<Context | null> {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const sysadmin = allows(profile, SPACE_MANAGE);
  if (!input.shareId) {
    const rows = await sql<{ id: string }>`
      select id from vault_portfolio where user_id = ${userId} and id = ${input.portfolioId} and not deleted limit 1
    `;
    return rows[0] ? { sql, ownerId: userId, portfolioId: input.portfolioId, canManage: true, sysadmin } : null;
  }
  const share = await shareForUser(sql, userId, input.shareId);
  if (!share || share.kind !== "portfolio") return null;
  if (!(await subtree(sql, share.ownerId, share.targetId)).includes(input.portfolioId)) return null;
  const access = await portfolioAccess(sql, share.ownerId, input.portfolioId, userId);
  if (!access) return null;
  return { sql, ownerId: share.ownerId, portfolioId: input.portfolioId, canManage: access === "admin" || sysadmin, sysadmin };
}

export type SpaceMember = {
  userId: string;
  name: string;
  loginName: string;
  access: ShareAccess | "owner";
  orgName: string | null;
  /** Se le puede cambiar el nivel (invitado directo, no el dueño). */
  accessEditable: boolean;
  shareId: string | null;
  used: number;
  limit: number | null;
};

async function describePortfolio(context: Context, userId: string) {
  const { sql, ownerId, portfolioId } = context;
  const names = await sql<{ name: string }>`select name from vault_portfolio where user_id = ${ownerId} and id = ${portfolioId} limit 1`;
  const owner = await sql<{ name: string }>`select name from "user" where id = ${ownerId} limit 1`;
  const usage = await portfolioUsage(sql, ownerId, portfolioId);
  const limits = await memberLimits(sql, ownerId, portfolioId);
  const shared = await portfolioMembers(sql, ownerId, portfolioId);
  const isWorkspace = Boolean(await workspaceByOwner(sql, ownerId));
  const members: SpaceMember[] = [
    ...(isWorkspace ? [] : [{
      userId: ownerId,
      name: owner[0]?.name?.trim() || "",
      loginName: "",
      access: "owner",
      orgName: null,
      accessEditable: false,
      shareId: null,
      used: usage.byUser.get(ownerId) ?? 0,
      limit: limits.get(ownerId) ?? null,
    } satisfies SpaceMember]),
    ...shared.map((member) => ({
      userId: member.userId,
      name: member.name,
      loginName: member.loginName,
      access: member.access,
      orgName: member.orgName,
      // También a quien llega por su organización: queda con su propio nivel.
      accessEditable: true,
      shareId: member.shareId,
      used: usage.byUser.get(member.userId) ?? 0,
      limit: limits.get(member.userId) ?? null,
    })),
  ];
  // Quien subió algo aquí pero ya no tiene acceso: su espacio sigue ocupado.
  for (const [uploader, used] of usage.byUser) {
    if (members.some((member) => member.userId === uploader) || uploader === ownerId) continue;
    const row = await sql<{ name: string }>`select name from "user" where id = ${uploader} limit 1`;
    members.push({
      userId: uploader,
      name: row[0]?.name?.trim() || "",
      loginName: "",
      access: "read",
      orgName: null,
      accessEditable: false,
      shareId: null,
      used,
      limit: limits.get(uploader) ?? null,
    });
  }
  const mine = members.find((member) => member.userId === userId);
  return {
    name: names[0]?.name ?? "",
    used: usage.total,
    limit: await portfolioLimit(sql, ownerId, portfolioId),
    canManage: context.canManage,
    canSetLimit: context.sysadmin,
    // Sin permiso para administrar, solo se ve lo propio.
    members: context.canManage ? members : mine ? [mine] : [],
  };
}

export const portfolioSpace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await portfolioContext(context.userId, data);
    if (!ctx) return { ok: false as const };
    return { ok: true as const, ...(await describePortfolio(ctx, context.userId)) };
  });

export const setMemberSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ userId: id, bytes }).parse(input))
  .handler(async ({ context, data }) => {
    const ctx = await portfolioContext(context.userId, data);
    if (!ctx?.canManage) return { ok: false as const, error: "No administras este portafolio." };
    const limits = await memberLimits(ctx.sql, ctx.ownerId, ctx.portfolioId);
    if (data.bytes === null) limits.delete(data.userId);
    else limits.set(data.userId, data.bytes);
    const problem = checkShares(await portfolioLimit(ctx.sql, ctx.ownerId, ctx.portfolioId), limits);
    if (problem) return { ok: false as const, error: problem };
    if (data.bytes === null) {
      await ctx.sql`
        delete from space_member where owner_id = ${ctx.ownerId} and portfolio_id = ${ctx.portfolioId} and user_id = ${data.userId}
      `;
    } else {
      await ctx.sql`
        insert into space_member (owner_id, portfolio_id, user_id, bytes)
        values (${ctx.ownerId}, ${ctx.portfolioId}, ${data.userId}, ${data.bytes})
        on conflict (owner_id, portfolio_id, user_id) do update set bytes = excluded.bytes
      `;
    }
    return { ok: true as const, ...(await describePortfolio(ctx, context.userId)) };
  });

export const setMemberAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    where.extend({ userId: id, memberShareId: id, access: z.enum(["read", "edit", "admin"]) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await portfolioContext(context.userId, data);
    if (!ctx?.canManage) return { ok: false as const, error: "No administras este portafolio." };
    // Solo en los elementos compartidos que cubren este portafolio.
    const member = (await portfolioMembers(ctx.sql, ctx.ownerId, ctx.portfolioId)).find(
      (item) => item.userId === data.userId && item.shareId === data.memberShareId,
    );
    if (!member) return { ok: false as const, error: "Ese usuario no tiene acceso aquí." };
    await setGrantAccess(ctx.sql, data.memberShareId, data.userId, data.access);
    return { ok: true as const, ...(await describePortfolio(ctx, context.userId)) };
  });

export const setPortfolioSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => where.extend({ bytes, ownerId: id.optional() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, SPACE_MANAGE)) return { ok: false as const, error: "Solo el administrador del sistema pone este espacio." };
    // Desde Administración → Espacio llega el dueño; desde el portafolio, el elemento compartido.
    const ctx = data.ownerId
      ? { sql, ownerId: data.ownerId, portfolioId: data.portfolioId, canManage: true, sysadmin: true }
      : await portfolioContext(context.userId, data);
    if (!ctx) return { ok: false as const, error: "Ese portafolio no existe." };
    // La raíz de un espacio de trabajo: su espacio es el del espacio de trabajo.
    const workspace = await workspaceByOwner(sql, ctx.ownerId);
    if (workspace && workspace.root_portfolio_id === ctx.portfolioId) {
      const problem = await checkWorkspaceBytes(sql, workspace.org_id, data.bytes);
      if (problem) return { ok: false as const, error: problem };
      await sql`update workspace set bytes = ${data.bytes} where org_id = ${workspace.org_id}`;
      return { ok: true as const };
    }
    const problem = checkShares(data.bytes, await memberLimits(sql, ctx.ownerId, ctx.portfolioId));
    if (problem) return { ok: false as const, error: problem };
    if (data.bytes === null) {
      await sql`delete from space_portfolio where owner_id = ${ctx.ownerId} and portfolio_id = ${ctx.portfolioId}`;
    } else {
      await sql`
        insert into space_portfolio (owner_id, portfolio_id, bytes) values (${ctx.ownerId}, ${ctx.portfolioId}, ${data.bytes})
        on conflict (owner_id, portfolio_id) do update set bytes = excluded.bytes
      `;
    }
    return { ok: true as const };
  });

// ---------------------------------------------------------------------------
// Administración → Espacio

async function sysadmin(userId: string): Promise<Sql | null> {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return allows(profile, SPACE_MANAGE) ? sql : null;
}

export const spaceOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const };
    const users = await sql<{ id: string; name: string; login: string | null; limit: unknown; used: unknown }>`
      select u.id, u.name, coalesce(r.login_name, a.login_name) as login, s.bytes as limit,
        (select coalesce(sum(d.file_size), 0)::bigint from vault_doc d
          where d.kind = 'file' and coalesce(d.uploaded_by, d.user_id) = u.id) as used
      from "user" u
      left join app_user_role r on r.user_id = u.id
      left join app_admin a on a.user_id = u.id
      left join space_user s on s.user_id = u.id
      where u.id not in (select owner_id from workspace)
      order by u.name
    `;
    // Los de los espacios de trabajo se administran en «Espacios de trabajo».
    const portfolios = await sql<{ owner_id: string; id: string; name: string; parent_id: string | null; owner_name: string }>`
      select p.user_id as owner_id, p.id, p.name, p.parent_id, u.name as owner_name
      from vault_portfolio p join "user" u on u.id = p.user_id
      where not p.deleted and p.user_id not in (select owner_id from workspace)
    `;
    const direct = await sql<{ owner_id: string; portfolio_id: string; bytes: unknown }>`
      select user_id as owner_id, portfolio_id, coalesce(sum(file_size), 0)::bigint as bytes
      from vault_doc where kind = 'file' and portfolio_id is not null group by 1, 2
    `;
    const limits = await sql<{ owner_id: string; portfolio_id: string; bytes: unknown }>`
      select owner_id, portfolio_id, bytes from space_portfolio
    `;
    const key = (owner: string, portfolio: string) => `${owner}/${portfolio}`;
    const own = new Map(direct.map((row) => [key(row.owner_id, row.portfolio_id), Number(row.bytes)]));
    const byKey = new Map(portfolios.map((row) => [key(row.owner_id, row.id), row]));
    // Lo de cada portafolio sube a todos los que lo contienen.
    const total = new Map<string, number>();
    for (const row of portfolios) {
      const bytes = own.get(key(row.owner_id, row.id)) ?? 0;
      const seen = new Set<string>();
      for (let at: (typeof portfolios)[number] | undefined = row; at && !seen.has(at.id); ) {
        seen.add(at.id);
        total.set(key(row.owner_id, at.id), (total.get(key(row.owner_id, at.id)) ?? 0) + bytes);
        at = at.parent_id ? byKey.get(key(row.owner_id, at.parent_id)) : undefined;
      }
    }
    const pathOf = (row: (typeof portfolios)[number]) => {
      const parts: string[] = [];
      const seen = new Set<string>();
      for (let at: (typeof portfolios)[number] | undefined = row; at && !seen.has(at.id); ) {
        seen.add(at.id);
        parts.unshift(at.name);
        at = at.parent_id ? byKey.get(key(row.owner_id, at.parent_id)) : undefined;
      }
      return parts.join(" / ");
    };
    return {
      ok: true as const,
      defaultLimit: await defaultUserLimit(sql),
      users: users.map((row) => ({
        id: row.id,
        name: row.name?.trim() || row.login || "",
        loginName: row.login ?? "",
        used: Number(row.used),
        limit: row.limit === null || row.limit === undefined ? null : Number(row.limit),
      })),
      portfolios: portfolios
        .map((row) => ({
          ownerId: row.owner_id,
          ownerName: row.owner_name?.trim() || "",
          id: row.id,
          path: pathOf(row),
          used: total.get(key(row.owner_id, row.id)) ?? 0,
          limit: (() => {
            const hit = limits.find((item) => item.owner_id === row.owner_id && item.portfolio_id === row.id);
            return hit ? Number(hit.bytes) : null;
          })(),
        }))
        .sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.path.localeCompare(b.path)),
    };
  });

export const setUserSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ userId: id, bytes }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const };
    if (data.bytes === null) await sql`delete from space_user where user_id = ${data.userId}`;
    else {
      await sql`
        insert into space_user (user_id, bytes) values (${data.userId}, ${data.bytes})
        on conflict (user_id) do update set bytes = excluded.bytes
      `;
    }
    return { ok: true as const };
  });

export const setDefaultUserSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ bytes }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const };
    if (data.bytes === null) await sql`delete from app_setting where key = ${DEFAULT_USER_KEY}`;
    else {
      await sql`
        insert into app_setting (key, value) values (${DEFAULT_USER_KEY}, ${String(data.bytes)})
        on conflict (key) do update set value = excluded.value
      `;
    }
    return { ok: true as const };
  });

/** El espacio propio (Cuenta y avisos de subida). */
export const mySpace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const { userUsage } = await import("@/server/space");
    return { used: await userUsage(sql, context.userId), limit: (await userLimit(sql, context.userId)).bytes };
  });

// ---------------------------------------------------------------------------
// Añadir a un portafolio compartido conmigo (permiso de edición)

async function writer(userId: string, shareId: string, portfolioId: string | null) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const share = await shareForUser(sql, userId, shareId);
  if (!share || share.kind !== "portfolio" || !canWrite(share.access)) return null;
  const target = await uploadTarget(sql, userId, { shareId, portfolioId });
  if (typeof target === "string") return null;
  return { sql, profile, target };
}

export const createSharedNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ shareId: id, portfolioId: id.nullable(), title: z.string().trim().max(200) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await writer(context.userId, data.shareId, data.portfolioId);
    if (!ctx || !allows(ctx.profile, PERMISSION.notesCreate)) return { ok: false as const, error: "No puedes crear notas aquí." };
    try {
      const doc = await createNote(ctx.sql, ctx.target.ownerId, {
        title: data.title || "Sin título",
        content: "",
        portfolioId: ctx.target.portfolioId,
        actor: ctx.profile.displayName || ctx.profile.loginName,
      });
      return { ok: true as const, id: doc.id };
    } catch (error) {
      return { ok: false as const, error: error instanceof VaultError ? error.message : "No se pudo crear la nota." };
    }
  });

export const addSharedFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        shareId: id,
        portfolioId: id.nullable(),
        key: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(200),
        mime: z.string().max(120),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await writer(context.userId, data.shareId, data.portfolioId);
    if (!ctx || !allows(ctx.profile, PERMISSION.filesUpload)) return { ok: false as const, error: "No puedes subir archivos aquí." };
    if (!(await mayUpload(ctx.sql, context.userId, data.key, data.shareId))) return { ok: false as const, error: "Esa subida no es tuya." };
    const size = await blobSize(ctx.sql, data.key);
    if (size === null) return { ok: false as const, error: "El archivo no llegó al servidor." };
    const full = await checkSpace(ctx.sql, { ...ctx.target, uploaderId: context.userId, bytes: size });
    if (full) return { ok: false as const, error: full };
    const actor = ctx.profile.displayName || ctx.profile.loginName;
    const now = Date.now();
    const doc: Document = {
      id: crypto.randomUUID(),
      title: data.name.replace(/\.[^.]+$/, "") || data.name,
      kind: "file",
      portfolioId: ctx.target.portfolioId,
      content: "",
      file: { name: data.name, mime: data.mime || "application/octet-stream", key: data.key, size },
      links: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    };
    await pushChanges(ctx.sql, ctx.target.ownerId, { docs: [doc], deletedDocs: [], portfolios: [], deletedPortfolios: [] });
    // Se le cuenta a quien lo subió, no al dueño del portafolio.
    await ctx.sql`update vault_doc set uploaded_by = ${context.userId} where user_id = ${ctx.target.ownerId} and id = ${doc.id}`;
    return (await getDoc(ctx.sql, ctx.target.ownerId, doc.id)) ? { ok: true as const, id: doc.id } : { ok: false as const, error: "No se pudo guardar el archivo." };
  });

export const createSharedPortfolio = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ shareId: id, parentId: id.nullable(), name: z.string().trim().min(1).max(120) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const ctx = await writer(context.userId, data.shareId, data.parentId);
    if (!ctx || !allows(ctx.profile, PERMISSION.portfoliosManage)) {
      return { ok: false as const, error: "No puedes crear portafolios aquí." };
    }
    try {
      const portfolio = await createPortfolio(ctx.sql, ctx.target.ownerId, { name: data.name, parentId: ctx.target.portfolioId });
      return { ok: true as const, id: portfolio.id };
    } catch (error) {
      return { ok: false as const, error: error instanceof VaultError ? error.message : "No se pudo crear el portafolio." };
    }
  });

