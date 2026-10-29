import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import type { Sql } from "@/lib/db";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { portfolioUsage } from "@/server/space";
import { checkWorkspaceBytes, createWorkspace, orgMemberIds, workspaceChildren, workspaces } from "@/server/workspace";

/**
 * Administración → Usuarios y permisos → Espacios de trabajo (permiso
 * `space.manage`): crear el de una organización, ponerle espacio y elegir sus
 * administradores. Lo de dentro (espacio de cada usuario, permisos) lo
 * administran ellos desde «Espacio y permisos» del espacio de trabajo.
 */

const SPACE_MANAGE = "space.manage";
const id = z.string().min(1).max(80);

async function sysadmin(userId: string): Promise<Sql | null> {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return allows(profile, SPACE_MANAGE) ? sql : null;
}

export const workspaceOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const };
    const orgs = await sql<{ id: string; name: string; parent_id: string | null }>`select id, name, parent_id from app_org order by name`;
    const rows = await workspaces(sql);
    const children = workspaceChildren(orgs, rows);
    const admins = await sql<{ share_id: string; user_id: string; name: string }>`
      select g.share_id, g.user_id, u.name from share_grant g join "user" u on u.id = g.user_id
      where g.access = 'admin' and g.share_id in (select share_id from workspace)
    `;
    const users = await sql<{ id: string; name: string; login: string | null }>`
      select u.id, u.name, coalesce(r.login_name, a.login_name) as login from "user" u
      left join app_user_role r on r.user_id = u.id
      left join app_admin a on a.user_id = u.id
      where u.id not in (select owner_id from workspace)
      order by u.name
    `;
    const byId = new Map(orgs.map((org) => [org.id, org]));
    const pathOf = (orgId: string) => {
      const parts: string[] = [];
      const seen = new Set<string>();
      for (let at = byId.get(orgId); at && !seen.has(at.id); at = at.parent_id ? byId.get(at.parent_id) : undefined) {
        seen.add(at.id);
        parts.unshift(at.name);
      }
      return parts;
    };
    const items = [];
    for (const org of orgs) {
      const row = rows.find((item) => item.org_id === org.id) ?? null;
      const bytes = row && row.bytes !== null && row.bytes !== undefined ? Number(row.bytes) : null;
      const given = (children.get(org.id) ?? []).reduce((sum, child) => sum + Number(child.bytes ?? 0), 0);
      items.push({
        orgId: org.id,
        path: pathOf(org.id),
        workspace: row
          ? {
              bytes,
              /** Lo asignado a las suborganizaciones (sale de `bytes`). */
              given,
              used: (await portfolioUsage(sql, row.owner_id, row.root_portfolio_id)).total,
              admins: admins
                .filter((admin) => admin.share_id === row.share_id)
                .map((admin) => ({ id: admin.user_id, name: admin.name?.trim() || "" })),
              /** Quién puede ser administrador: los de la organización y sus suborganizaciones. */
              candidates: [...(await orgMemberIds(sql, org.id))],
            }
          : null,
      });
    }
    items.sort((a, b) => a.path.join(" / ").localeCompare(b.path.join(" / ")));
    return {
      ok: true as const,
      items,
      users: users.map((user) => ({ id: user.id, name: user.name?.trim() || user.login || "", loginName: user.login ?? "" })),
    };
  });

export const createOrgWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ orgId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const, error: "Sin permiso." };
    return createWorkspace(sql, data.orgId);
  });

export const setWorkspaceSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ orgId: id, bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const, error: "Sin permiso." };
    const problem = await checkWorkspaceBytes(sql, data.orgId, data.bytes);
    if (problem) return { ok: false as const, error: problem };
    await sql`update workspace set bytes = ${data.bytes} where org_id = ${data.orgId}`;
    return { ok: true as const };
  });

/** Hace (o deja de hacer) a un usuario administrador del espacio de trabajo. */
export const setWorkspaceAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ orgId: id, userId: id, admin: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await sysadmin(context.userId);
    if (!sql) return { ok: false as const, error: "Sin permiso." };
    const row = (await workspaces(sql)).find((item) => item.org_id === data.orgId);
    if (!row) return { ok: false as const, error: "Esa organización no tiene espacio de trabajo." };
    if (data.admin && !(await orgMemberIds(sql, data.orgId)).has(data.userId)) {
      return { ok: false as const, error: "Solo puede administrarlo alguien de esa organización o de sus suborganizaciones." };
    }
    if (data.admin) {
      await sql`
        insert into share_grant (share_id, user_id, access) values (${row.share_id}, ${data.userId}, 'admin')
        on conflict (share_id, user_id) do update set access = 'admin'
      `;
    } else {
      // Sigue con el acceso de su organización, si es miembro.
      await sql`delete from share_grant where share_id = ${row.share_id} and user_id = ${data.userId}`;
    }
    return { ok: true as const };
  });
