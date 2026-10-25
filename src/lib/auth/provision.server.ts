import type { Sql } from "../db";

/**
 * Alta de cuentas que llegan por LDAP, OAuth o SSO (solo servidor): les da el
 * rol por defecto del proveedor y un nombre de usuario único, igual que una
 * cuenta creada desde Administración.
 */

function slug(value: string): string {
  const base = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 28);
  return base || "usuario";
}

async function uniqueLogin(sql: Sql, wanted: string): Promise<string> {
  const base = slug(wanted);
  let candidate = base;
  for (let index = 2; index < 1000; index += 1) {
    const taken = await sql<{ user_id: string }>`select user_id from app_user_role where login_name = ${candidate} limit 1`;
    if (!taken[0]) return candidate;
    candidate = `${base}-${index}`;
  }
  return `${base}-${Date.now()}`;
}

/** Asigna rol y nombre de usuario a una cuenta externa recién creada (idempotente). */
export async function provisionExternalUser(
  sql: Sql,
  input: { userId: string; source: string; login: string; roleId: string },
): Promise<void> {
  const existing = await sql<{ user_id: string }>`select user_id from app_user_role where user_id = ${input.userId} limit 1`;
  if (existing[0]) return;
  const role = await sql<{ id: string }>`select id from app_role where id = ${input.roleId} limit 1`;
  const roleId = role[0]?.id ?? "miembro";
  const login = await uniqueLogin(sql, input.login);
  await sql`
    insert into app_user_role (user_id, role_id, login_name, source)
    values (${input.userId}, ${roleId}, ${login}, ${input.source})
    on conflict (user_id) do nothing
  `;
  await sql`
    insert into app_log (id, actor, area, message)
    values (${crypto.randomUUID()}, ${input.source}, 'Usuarios', ${`Alta automática de ${login} (${input.source})`})
  `;
}
