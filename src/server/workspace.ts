import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { formatBytes } from "@/domain/space";
import { createPortfolio } from "./vault";

/**
 * Espacios de trabajo (solo servidor). Ver `migrations/0024_workspaces.sql`.
 *
 * Un espacio de trabajo es la bóveda de una cuenta interna, compartida con su
 * organización. Los miembros ven el espacio; lo de dentro solo lo ve quien
 * administra o quien tiene una fila en `workspace_access` (migración 0032).
 * El espacio de una organización sale del de la organización con espacio de
 * trabajo más cercana por encima.
 */

export type WorkspaceRow = {
  org_id: string;
  owner_id: string;
  root_portfolio_id: string;
  share_id: string;
  bytes: unknown;
};

type OrgRow = { id: string; name: string; parent_id: string | null };

export async function workspaces(sql: Sql): Promise<WorkspaceRow[]> {
  return sql<WorkspaceRow>`select org_id, owner_id, root_portfolio_id, share_id, bytes from workspace`;
}

export async function workspaceByOwner(sql: Sql, ownerId: string): Promise<WorkspaceRow | null> {
  const rows = await sql<WorkspaceRow>`
    select org_id, owner_id, root_portfolio_id, share_id, bytes from workspace where owner_id = ${ownerId} limit 1
  `;
  return rows[0] ?? null;
}

const bytesOf = (row: WorkspaceRow): number | null => (row.bytes === null || row.bytes === undefined ? null : Number(row.bytes));

/**
 * Para cada espacio de trabajo, los de las organizaciones de debajo cuyo
 * espacio sale del suyo: los más cercanos (los que no tienen otro en medio).
 */
export function workspaceChildren(orgs: OrgRow[], rows: WorkspaceRow[]): Map<string, WorkspaceRow[]> {
  const byOrg = new Map(rows.map((row) => [row.org_id, row]));
  const parent = new Map(orgs.map((org) => [org.id, org.parent_id]));
  const out = new Map<string, WorkspaceRow[]>();
  for (const row of rows) {
    const seen = new Set<string>([row.org_id]);
    for (let at = parent.get(row.org_id) ?? null; at && !seen.has(at); at = parent.get(at) ?? null) {
      seen.add(at);
      const above = byOrg.get(at);
      if (above) {
        out.set(above.org_id, [...(out.get(above.org_id) ?? []), row]);
        break;
      }
    }
  }
  return out;
}

/** El espacio de trabajo con espacio propio más cercano por encima (de quien sale el suyo). */
function parentWorkspace(orgs: OrgRow[], rows: WorkspaceRow[], orgId: string): WorkspaceRow | null {
  const byOrg = new Map(rows.map((row) => [row.org_id, row]));
  const parent = new Map(orgs.map((org) => [org.id, org.parent_id]));
  const seen = new Set<string>([orgId]);
  for (let at = parent.get(orgId) ?? null; at && !seen.has(at); at = parent.get(at) ?? null) {
    seen.add(at);
    const above = byOrg.get(at);
    if (above) return above;
  }
  return null;
}

/**
 * Lo que puede ocupar el contenido propio de un espacio de trabajo: su espacio
 * menos lo asignado a los de debajo (`null`: sin tope).
 */
export async function workspaceOwnLimit(sql: Sql, ownerId: string): Promise<number | null> {
  const row = await workspaceByOwner(sql, ownerId);
  if (!row) return null;
  const total = bytesOf(row);
  if (total === null) return null;
  const orgs = await sql<OrgRow>`select id, name, parent_id from app_org`;
  const given = (workspaceChildren(orgs, await workspaces(sql)).get(row.org_id) ?? []).reduce(
    (sum, child) => sum + (bytesOf(child) ?? 0),
    0,
  );
  return Math.max(0, total - given);
}

/**
 * Valida el espacio de un espacio de trabajo: lo de todas las organizaciones
 * hermanas no puede pasar del de arriba, ni quedar por debajo de lo que esta ya
 * repartió a las suyas. Devuelve el motivo si no vale.
 */
export async function checkWorkspaceBytes(sql: Sql, orgId: string, bytes: number | null): Promise<string | null> {
  const orgs = await sql<OrgRow>`select id, name, parent_id from app_org`;
  const rows = await workspaces(sql);
  const children = workspaceChildren(orgs, rows);
  const given = (children.get(orgId) ?? []).reduce((sum, child) => sum + (bytesOf(child) ?? 0), 0);
  if (bytes !== null && given > bytes) {
    return `Sus organizaciones ya tienen ${formatBytes(given)} asignados: el espacio no puede ser menor.`;
  }
  const above = parentWorkspace(orgs, rows, orgId);
  const total = above ? bytesOf(above) : null;
  if (!above || total === null) return null;
  if (bytes === null) return `Sale del espacio de «${orgName(orgs, above.org_id)}»: hay que ponerle un tope.`;
  const siblings = (children.get(above.org_id) ?? []).filter((row) => row.org_id !== orgId);
  const others = siblings.reduce((sum, row) => sum + (bytesOf(row) ?? 0), 0);
  if (others + bytes > total) {
    return `«${orgName(orgs, above.org_id)}» tiene ${formatBytes(total)} y ya asignó ${formatBytes(others)}: quedan ${formatBytes(Math.max(0, total - others))}.`;
  }
  return null;
}

function orgName(orgs: OrgRow[], id: string): string {
  return orgs.find((org) => org.id === id)?.name ?? "";
}

/** Crea el espacio de trabajo de una organización: su cuenta interna, su portafolio raíz y lo compartido con ella. */
export async function createWorkspace(sql: Sql, orgId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const org = (await sql<OrgRow>`select id, name, parent_id from app_org where id = ${orgId} limit 1`)[0];
  if (!org) return { ok: false, error: "Esa organización no existe." };
  if (await sql<{ org_id: string }>`select org_id from workspace where org_id = ${orgId} limit 1`.then((rows) => rows[0])) {
    return { ok: false, error: "Esa organización ya tiene espacio de trabajo." };
  }
  const ownerId = `ws-${randomUUID()}`;
  // Una cuenta sin contraseña ni proveedor: nadie puede entrar con ella.
  await sql`
    insert into "user" (id, name, email, "emailVerified")
    values (${ownerId}, ${org.name}, ${`${ownerId}@workspace.invalid`}, false)
  `;
  const root = await createPortfolio(sql, ownerId, { name: org.name, parentId: null });
  const shareId = randomUUID();
  await sql`
    insert into share_item (id, owner_id, kind, target_id, title, visibility, access)
    values (${shareId}, ${ownerId}, 'portfolio', ${root.id}, ${org.name}, 'shared', 'read')
  `;
  await sql`insert into share_org_grant (share_id, org_id, granted_at) values (${shareId}, ${orgId}, ${Date.now()})`;
  await sql`
    insert into workspace (org_id, owner_id, root_portfolio_id, share_id, bytes, created_at)
    values (${orgId}, ${ownerId}, ${root.id}, ${shareId}, null, ${Date.now()})
  `;
  return { ok: true };
}

/** Los miembros de una organización y de todas sus suborganizaciones. */
export async function orgMemberIds(sql: Sql, orgId: string): Promise<Set<string>> {
  const rows = await sql<{ user_id: string }>`
    with recursive tree(id) as (
      select id from app_org where id = ${orgId}
      union
      select c.id from app_org c join tree t on c.parent_id = t.id
    )
    select distinct m.user_id from app_org_member m join tree t on t.id = m.org_id
  `;
  return new Set(rows.map((row) => row.user_id));
}

export type FolderLevel = "read" | "edit";

/** Acceso de una persona a un portafolio del espacio (`null`: no ve lo de dentro). */
export async function workspaceFolderLevel(
  sql: Sql,
  ownerId: string,
  portfolioId: string,
  userId: string,
): Promise<FolderLevel | null> {
  const rows = await sql<{ access: string }>`
    select access from workspace_access
    where owner_id = ${ownerId} and portfolio_id = ${portfolioId} and user_id = ${userId}
    limit 1
  `;
  const access = rows[0]?.access;
  return access === "read" || access === "edit" ? access : null;
}

/** Concesiones de una persona en un espacio de trabajo, para filtrar el árbol. */
export async function workspaceGrants(sql: Sql, ownerId: string, userId: string): Promise<[string, FolderLevel][]> {
  const rows = await sql<{ portfolio_id: string; access: string }>`
    select portfolio_id, access from workspace_access where owner_id = ${ownerId} and user_id = ${userId}
  `;
  return rows.flatMap((row) =>
    row.access === "read" || row.access === "edit" ? [[row.portfolio_id, row.access] as [string, FolderLevel]] : [],
  );
}

/** Da, cambia o quita el acceso de una persona en esos portafolios. */
export async function grantWorkspaceFolders(
  sql: Sql,
  ownerId: string,
  portfolioIds: readonly string[],
  userId: string,
  access: FolderLevel | null,
): Promise<void> {
  for (const portfolioId of portfolioIds) {
    if (access === null) {
      await sql`
        delete from workspace_access
        where owner_id = ${ownerId} and portfolio_id = ${portfolioId} and user_id = ${userId}
      `;
    } else {
      await sql`
        insert into workspace_access (owner_id, portfolio_id, user_id, access)
        values (${ownerId}, ${portfolioId}, ${userId}, ${access})
        on conflict (owner_id, portfolio_id, user_id) do update set access = excluded.access
      `;
    }
  }
}

export type WorkspacePerson = {
  userId: string;
  name: string;
  loginName: string;
  /** `null`: ve el espacio, no esta carpeta. */
  access: FolderLevel | null;
  admin: boolean;
};

/** Miembros de la organización del espacio y el acceso que tienen en un portafolio. */
export async function workspaceAudience(
  sql: Sql,
  orgId: string,
  ownerId: string,
  portfolioId: string,
): Promise<WorkspacePerson[]> {
  const rows = await sql<{ id: string; name: string; login: string | null; folder_access: string | null; admin: unknown }>`
    with recursive tree(id) as (
      select id from app_org where id = ${orgId}
      union
      select c.id from app_org c join tree t on c.parent_id = t.id
    )
    select distinct u.id, u.name, coalesce(r.login_name, a.login_name) as login,
      g.access as folder_access,
      exists (
        select 1 from share_grant sg
        join workspace w on w.share_id = sg.share_id
        where w.owner_id = ${ownerId} and sg.user_id = u.id and sg.access = 'admin'
          and (sg.expires_at is null or sg.expires_at > ${Date.now()})
      ) as admin
    from app_org_member m
    join tree t on t.id = m.org_id
    join "user" u on u.id = m.user_id
    left join app_user_role r on r.user_id = u.id
    left join app_admin a on a.user_id = u.id
    left join workspace_access g
      on g.owner_id = ${ownerId} and g.portfolio_id = ${portfolioId} and g.user_id = u.id
    order by u.name
  `;
  return rows.map((row) => ({
    userId: row.id,
    name: row.name?.trim() || row.login || "",
    loginName: row.login ?? "",
    access: row.folder_access === "read" || row.folder_access === "edit" ? row.folder_access : null,
    admin: row.admin === true || row.admin === "t" || row.admin === 1,
  }));
}
