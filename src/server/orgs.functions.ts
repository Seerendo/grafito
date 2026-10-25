import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { requireLease } from "@/server/lease";
import { createOrg, deleteOrg, listOrgs, moveOrg, renameOrg, setOrgMembers } from "@/server/orgs";
import { allows, readUserProfile } from "@/server/profile";

/** Funciones de servidor de organizaciones (Administración → Usuarios y permisos). */

const id = z.string().min(1).max(80);

async function manager(userId: string) {
  const sql = await requireLease(userId);
  const actor = await readUserProfile(sql, userId);
  return { sql, actor, ok: allows(actor, "orgs.manage") };
}

async function log(sql: Awaited<ReturnType<typeof requireLease>>, actor: string, message: string) {
  await sql`
    insert into app_log (id, actor, area, message)
    values (${crypto.randomUUID()}, ${actor}, 'Organizaciones', ${message})
  `;
}

const DENIED = { ok: false as const, error: "Sin permiso para administrar organizaciones." };

export const orgsState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ok } = await manager(context.userId);
    if (!ok) return { ok: false as const, orgs: [] };
    return { ok: true as const, orgs: await listOrgs(sql) };
  });

export const createOrgFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ name: z.string().max(80), parentId: id.nullable() }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, actor, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    const result = await createOrg(sql, data.name, data.parentId);
    if (result.ok) await log(sql, actor.loginName || actor.displayName, `Crea ${data.name.trim()}`);
    return result;
  });

export const renameOrgFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id, name: z.string().max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    return renameOrg(sql, data.id, data.name);
  });

export const moveOrgFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id, parentId: id.nullable() }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    return moveOrg(sql, data.id, data.parentId);
  });

export const deleteOrgFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, actor, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    await deleteOrg(sql, data.id);
    await log(sql, actor.loginName || actor.displayName, "Borra una organización");
    return { ok: true as const };
  });

export const setOrgMembersFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id, userIds: z.array(id).max(5000) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    await setOrgMembers(sql, data.id, data.userIds);
    return { ok: true as const };
  });
