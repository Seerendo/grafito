import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { formatBytes } from "@/domain/space";
import { createPortfolio } from "./vault";

/**
 * Espacios de trabajo (solo servidor). Ver `migrations/0024_workspaces.sql`.
 *
 * Un espacio de trabajo es la bóveda de una cuenta interna, compartida con su
 * organización: así funcionan sin más los permisos por persona, el reparto de
 * espacio (`space.ts`) y añadir notas y archivos desde el visor de lo
 * compartido. El espacio de una organización sale del de la organización con
 * espacio de trabajo más cercana por encima.
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
    values (${shareId}, ${ownerId}, 'portfolio', ${root.id}, ${org.name}, 'shared', 'edit')
  `;
  await sql`insert into share_org_grant (share_id, org_id) values (${shareId}, ${orgId})`;
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
