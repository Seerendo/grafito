import type { Sql } from "../db";
import { logActivity } from "@/server/audit";

/**
 * Provision LDAP/OAuth/SSO accounts with the provider's default role and a unique username,
 * matching administrator-created accounts.
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
    const taken = await sql<{
      user_id: string;
    }>`select user_id from app_user_role where login_name = ${candidate} limit 1`;
    if (!taken[0]) return candidate;
    candidate = `${base}-${index}`;
  }
  return `${base}-${Date.now()}`;
}

/** Idempotently assign role and username to a newly provisioned external account. */
export async function provisionExternalUser(
  sql: Sql,
  input: { userId: string; source: string; login: string; roleId: string },
): Promise<void> {
  const existing = await sql<{
    user_id: string;
  }>`select user_id from app_user_role where user_id = ${input.userId} limit 1`;
  if (existing[0]) return;
  const role = await sql<{
    id: string;
  }>`select id from app_role where id = ${input.roleId} limit 1`;
  const roleId = role[0]?.id ?? "miembro";
  const login = await uniqueLogin(sql, input.login);
  await sql`
    insert into app_user_role (user_id, role_id, login_name, source)
    values (${input.userId}, ${roleId}, ${login}, ${input.source})
    on conflict (user_id) do nothing
  `;
  await logActivity(sql, {
    actorId: input.userId,
    actorName: input.source,
    area: "Usuarios",
    message: `Alta automática de ${login} (${input.source})`,
  });
}

/** Synthetic local/LDAP fallback email addresses do not belong to real recipients. */
const SYNTHETIC = /@(?:ldap\.)?grafito\.app$/i;

/**
 * Refresh external account email from its provider on each sign-in and disallow local editing.
 * Leave local accounts unchanged; see externalEmail.
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

/** Whether an external provider controls the account email, and which provider. */
export async function externalEmail(sql: Sql, userId: string): Promise<string | null> {
  const rows = await sql<{
    source: string | null;
  }>`select source from app_user_role where user_id = ${userId} limit 1`;
  const source = rows[0]?.source;
  return source && source !== "local" ? source : null;
}
