import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { wouldCycle, type Org } from "@/domain/orgs";

/** Acceso a datos de organizaciones (solo servidor). Ver `migrations/0007_orgs_auth.sql`. */

export type OrgRow = Org & { memberIds: string[] };

export async function listOrgs(sql: Sql): Promise<OrgRow[]> {
  const orgs = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from app_org order by name
  `;
  const members = await sql<{ org_id: string; user_id: string }>`select org_id, user_id from app_org_member`;
  return orgs.map((org) => ({
    id: org.id,
    name: org.name,
    parentId: org.parent_id,
    memberIds: members.filter((member) => member.org_id === org.id).map((member) => member.user_id),
  }));
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

async function nameTaken(sql: Sql, name: string, parentId: string | null, exceptId?: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from app_org
    where lower(name) = lower(${name})
      and coalesce(parent_id, '') = coalesce(${parentId}, '')
      and id <> coalesce(${exceptId ?? null}, '')
    limit 1
  `;
  return rows.length > 0;
}

export async function createOrg(sql: Sql, name: string, parentId: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "Escribe un nombre." };
  if (parentId) {
    const parent = await sql<{ id: string }>`select id from app_org where id = ${parentId} limit 1`;
    if (!parent[0]) return { ok: false, error: "La organización madre no existe." };
  }
  if (await nameTaken(sql, clean, parentId)) return { ok: false, error: "Ya hay una organización con ese nombre ahí." };
  const id = randomUUID();
  await sql`insert into app_org (id, name, parent_id) values (${id}, ${clean}, ${parentId})`;
  return { ok: true, id };
}

export async function renameOrg(sql: Sql, id: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: "Escribe un nombre." };
  const rows = await sql<{ parent_id: string | null }>`select parent_id from app_org where id = ${id} limit 1`;
  if (!rows[0]) return { ok: false, error: "Esa organización no existe." };
  if (await nameTaken(sql, clean, rows[0].parent_id, id)) return { ok: false, error: "Ya hay una organización con ese nombre ahí." };
  await sql`update app_org set name = ${clean} where id = ${id}`;
  // Su espacio de trabajo (si tiene) se llama igual: la cuenta, el portafolio raíz y lo compartido.
  const workspace = await sql<{ owner_id: string; root_portfolio_id: string; share_id: string }>`
    select owner_id, root_portfolio_id, share_id from workspace where org_id = ${id} limit 1
  `;
  if (workspace[0]) {
    const { owner_id: owner, root_portfolio_id: root, share_id: share } = workspace[0];
    await sql`update "user" set name = ${clean} where id = ${owner}`;
    await sql`update vault_portfolio set name = ${clean} where user_id = ${owner} and id = ${root}`;
    await sql`update share_item set title = ${clean} where id = ${share}`;
  }
  return { ok: true };
}

export async function moveOrg(sql: Sql, id: string, parentId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgs = await listOrgs(sql);
  const org = orgs.find((item) => item.id === id);
  if (!org) return { ok: false, error: "Esa organización no existe." };
  if (wouldCycle(orgs, id, parentId)) return { ok: false, error: "No se puede mover dentro de sí misma." };
  if (await nameTaken(sql, org.name, parentId, id)) return { ok: false, error: "Ya hay una organización con ese nombre ahí." };
  await sql`update app_org set parent_id = ${parentId} where id = ${id}`;
  return { ok: true };
}

/** Borra la organización con sus sub-organizaciones (en cascada). */
export async function deleteOrg(sql: Sql, id: string): Promise<void> {
  await sql`delete from app_org where id = ${id}`;
}

/**
 * Los miembros directos de una organización. Quien entra en una
 * sub-organización entra también en todas las de arriba (quitarlo de una no lo
 * quita de las demás).
 */
export async function setOrgMembers(sql: Sql, id: string, userIds: string[]): Promise<void> {
  const before = new Set(
    (await sql<{ user_id: string }>`select user_id from app_org_member where org_id = ${id}`).map((row) => row.user_id),
  );
  const ancestors = await sql<{ id: string }>`
    with recursive up(id, parent_id) as (
      select id, parent_id from app_org where id = ${id}
      union
      select o.id, o.parent_id from app_org o join up on o.id = up.parent_id
    )
    select id from up where id <> ${id}
  `;
  await sql`delete from app_org_member where org_id = ${id}`;
  for (const userId of new Set(userIds)) {
    await sql`
      insert into app_org_member (org_id, user_id)
      select ${id}, u.id from "user" u where u.id = ${userId}
      on conflict do nothing
    `;
    if (before.has(userId)) continue;
    for (const ancestor of ancestors) {
      await sql`
        insert into app_org_member (org_id, user_id)
        select ${ancestor.id}, u.id from "user" u where u.id = ${userId}
        on conflict do nothing
      `;
    }
  }
}
