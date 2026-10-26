import type { Sql } from "@/lib/db";

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export type UserProfile = {
  displayName: string;
  contactEmail: string;
  email: string;
  isAdmin: boolean;
  canAdmin: boolean;
  loginName: string;
  roleId: string;
  roleName: string;
  mustChangePassword: boolean;
  permissions: string[];
  /** Idioma elegido en Cuenta → Preferencias ("" = sin elegir). */
  locale: "es" | "en" | "";
};

export function allows(profile: Pick<UserProfile, "isAdmin" | "permissions">, key: string): boolean {
  return profile.isAdmin || profile.permissions.includes(key);
}

/**
 * Solo los permisos del usuario, en una consulta: lo que el pulso de sesión
 * devuelve para que el cliente aplique los cambios de rol en vivo.
 */
export async function readPermissionGrants(
  sql: Sql,
  userId: string,
): Promise<{ isAdmin: boolean; permissions: string[] }> {
  const rows = await sql<{ owner: unknown; keys: string | null }>`
    select
      exists(select 1 from app_admin a where a.user_id = ${userId}) as owner,
      (
        select string_agg(rp.permission_key, ',')
        from app_user_role m
        join app_role_permission rp on rp.role_id = m.role_id
        where m.user_id = ${userId}
      ) as keys
  `;
  const row = rows[0];
  const isAdmin = flag(row?.owner);
  return { isAdmin, permissions: isAdmin ? [] : (row?.keys ?? "").split(",").filter(Boolean) };
}

export async function readUserProfile(sql: Sql, userId: string): Promise<UserProfile> {
  const user = await sql<{ name: string; email: string }>`
    select name, email from "user" where id = ${userId} limit 1
  `;
  const admin = await sql<{ must_change_password: unknown; login_name: string }>`
    select must_change_password, login_name from app_admin where user_id = ${userId} limit 1
  `;
  const contact = await sql<{ contact_email: string | null; locale: string | null }>`
    select contact_email, locale from app_profile where user_id = ${userId} limit 1
  `;
  const membership = await sql<{ role_id: string; login_name: string; role_name: string }>`
    select m.role_id, m.login_name, r.name as role_name
    from app_user_role m
    join app_role r on r.id = m.role_id
    where m.user_id = ${userId}
    limit 1
  `;
  const owner = Boolean(admin[0]);
  const roleId = owner ? "admin" : (membership[0]?.role_id ?? "");
  const grants = roleId
    ? await sql<{ permission_key: string }>`
        select permission_key from app_role_permission where role_id = ${roleId}
      `
    : [];
  const permissions = owner
    ? (await sql<{ key: string }>`select key from app_permission`).map((row) => row.key)
    : grants.map((row) => row.permission_key);
  const row = admin[0];
  return {
    displayName: user[0]?.name?.trim() || (owner ? "Administrador" : "Cuenta"),
    contactEmail: contact[0]?.contact_email?.trim() || "",
    email: user[0]?.email ?? "",
    isAdmin: owner,
    canAdmin: owner || permissions.includes("admin.access"),
    loginName: row?.login_name || membership[0]?.login_name || "",
    roleId,
    roleName: owner ? "Administrador" : (membership[0]?.role_name ?? ""),
    mustChangePassword: flag(row?.must_change_password),
    permissions,
    locale: contact[0]?.locale === "en" || contact[0]?.locale === "es" ? contact[0].locale : "",
  };
}
