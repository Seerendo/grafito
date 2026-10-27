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

/** Direcciones que Grafito se inventa (usuario local, LDAP sin correo): no son de nadie. */
const SYNTHETIC = /@(?:ldap\.)?grafito\.app$/i;

/**
 * El correo de una cuenta que entra por LDAP, OAuth o SSO es el que da su
 * proveedor: se copia al correo de la cuenta en cada ingreso y no se puede
 * cambiar en Grafito (ver `externalEmail`). Las cuentas locales no se tocan.
 */
export async function syncExternalEmail(sql: Sql, userId: string): Promise<void> {
  const rows = await sql<{ email: string; source: string | null }>`
    select u.email, m.source from "user" u left join app_user_role m on m.user_id = u.id where u.id = ${userId} limit 1
  `;
  const row = rows[0];
  if (!row?.source || row.source === "local") return;
  const email = SYNTHETIC.test(row.email) ? null : row.email;
  await sql`
    insert into app_profile (user_id, contact_email) values (${userId}, ${email})
    on conflict (user_id) do update set contact_email = excluded.contact_email
  `;
}

/** Si el correo de la cuenta lo fija su proveedor externo (y cuál es el proveedor). */
export async function externalEmail(sql: Sql, userId: string): Promise<string | null> {
  const rows = await sql<{ source: string | null }>`select source from app_user_role where user_id = ${userId} limit 1`;
  const source = rows[0]?.source;
  return source && source !== "local" ? source : null;
}
