import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { removeUserFiles } from "@/server/files";
import { requireLease, readTtl } from "@/server/lease";
import { ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD, STRONG_PASSWORD, documentEngine, emailForUsername, fileEngine, relationalEngine } from "@/server/platform";
import { allows, readUserProfile } from "@/server/profile";
import { mirrorToElastic, probeElastic, searchElastic, type IndexDoc } from "@/server/search";
import { probeBucket } from "@/server/storage";

type Sql = Awaited<ReturnType<typeof import("@/lib/db").getSql>>;

const docSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(200),
  kind: z.enum(["markdown", "file"]),
  portfolioId: z.string().max(80).nullable(),
  body: z.string().max(4000),
  links: z.array(z.object({ targetId: z.string().max(80), kind: z.enum(["referencia", "llama"]) })).max(80),
});

function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, "")}%`;
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

/** Fecha de la base en milisegundos, o `null` si no hay. */
function epoch(value: unknown): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function sqlClient(): Promise<Sql> {
  const { getSql } = await import("@/lib/db");
  return getSql();
}

async function isAdmin(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ user_id: string }>`select user_id from app_admin where user_id = ${userId} limit 1`;
  return rows.length > 0;
}

async function ensureAdminGrants(sql: Sql): Promise<void> {
  await sql`
    insert into app_role_permission (role_id, permission_key)
    select 'admin', key from app_permission
    on conflict do nothing
  `;
}

async function writeLog(sql: Sql, actor: string, area: string, message: string): Promise<void> {
  await sql`
    insert into app_log (id, actor, area, message)
    values (${crypto.randomUUID()}, ${actor}, ${area}, ${message})
  `;
}

function roleSlug(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const suffix = crypto.randomUUID().slice(0, 8);
  return `r-${base || "rol"}-${suffix}`;
}

async function authHeaders(): Promise<Headers> {
  const headers = new Headers();
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    const origin = request?.headers.get("origin") || (request ? new URL(request.url).origin : "");
    if (origin) headers.set("origin", origin);
  } catch {
    /* called outside a request */
  }
  if (!headers.has("origin")) headers.set("origin", "http://127.0.0.1:8080");
  return headers;
}

async function discardUnchosenAdmin(sql: Sql): Promise<void> {
  const rows = await sql<{ user_id: string; must_change_password: unknown; chosen: unknown }>`
    select user_id, must_change_password, chosen from app_admin
  `;
  for (const row of rows) {
    if (flag(row.chosen)) continue;
    if (!flag(row.must_change_password)) {
      await sql`update app_admin set chosen = true where user_id = ${row.user_id}`;
      continue;
    }
    await sql`delete from "user" where id = ${row.user_id}`;
  }
}

export const accessState = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await discardUnchosenAdmin(sql);
  const rows = await sql<{ login_name: string; must_change_password: unknown }>`
    select login_name, must_change_password from app_admin limit 1
  `;
  const row = rows[0];
  if (!row) return { installed: false as const, loginName: "admin", mustChangePassword: false };
  return {
    installed: true as const,
    loginName: row.login_name || "admin",
    mustChangePassword: flag(row.must_change_password),
  };
});

export const createInitialAdmin = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        username: z.string().trim().min(1).max(32),
        password: z.string().min(4).max(128),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const email = emailForUsername(data.username);
    if (!email) {
      return { ok: false as const, error: "El usuario solo admite letras, números, punto, guion y guion bajo." };
    }
    const sql = await sqlClient();
    await discardUnchosenAdmin(sql);
    const existing = await sql<{ user_id: string }>`select user_id from app_admin limit 1`;
    if (existing.length > 0) {
      return { ok: false as const, error: "El administrador ya está creado. Entra con ese usuario." };
    }
    const auth = await (await import("@/lib/auth/server")).getAuth();
    try {
      await auth.api.signUpEmail({
        body: { name: "Administrador", email, password: data.password },
        headers: await authHeaders(),
      });
    } catch {
      return { ok: false as const, error: "No se pudo crear el administrador." };
    }
    const created = await sql<{ id: string }>`select id from "user" where email = ${email} limit 1`;
    const id = created[0]?.id;
    if (!id) return { ok: false as const, error: "No se pudo crear el administrador." };
    const login = data.username.trim().toLowerCase();
    // Solo se obliga a cambiarla si quien instala eligió la de ejemplo o una corta.
    const mustChange = data.password === ADMIN_INITIAL_PASSWORD || data.password.length < STRONG_PASSWORD;
    await sql`
      insert into app_admin (user_id, must_change_password, login_name, chosen)
      values (${id}, ${mustChange}, ${login}, true)
      on conflict (user_id) do nothing
    `;
    await sql`
      insert into app_user_role (user_id, role_id, login_name)
      values (${id}, 'admin', ${login})
      on conflict (user_id) do update set role_id = 'admin'
    `;
    return { ok: true as const, email };
  });

export const sessionProfile = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    return readUserProfile(sql, context.userId);
  });

export const adminState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    const empty = {
      email: profile.email,
      loginName: profile.loginName,
      displayName: profile.displayName,
      contactEmail: profile.contactEmail,
      mustChangePassword: profile.mustChangePassword,
      sessionTtl: await readTtl(sql),
      roles: [],
      permissions: [],
      users: [],
      sources: [],
      plugins: [],
      indexed: 0,
      owner: profile.isAdmin,
      actorPermissions: [] as string[],
      engines: { relational: relationalEngine(), documents: documentEngine(), files: fileEngine() },
    };
    if (!profile.canAdmin) return { isAdmin: false as const, ...empty };
    await ensureAdminGrants(sql);
    const roles = await sql<{ id: string; name: string; fixed: unknown }>`select id, name, fixed from app_role order by name`;
    const permissions = await sql<{ key: string; label: string; description: string; area: string; sort: number }>`
      select key, label, description, area, sort from app_permission order by sort, label
    `;
    const grants = await sql<{ role_id: string; permission_key: string }>`
      select role_id, permission_key from app_role_permission
    `;
    const sources = await sql<{ id: string; kind: string; label: string; enabled: unknown }>`
      select id, kind, label, enabled from app_source order by label
    `;
    const plugins = await sql<{ id: string; name: string; description: string; enabled: unknown; built_in: unknown }>`
      select id, name, description, enabled, built_in from app_plugin order by name
    `;
    const count = await sql<{ n: number }>`select count(*)::int as n from doc_index where user_id = ${context.userId}`;
    const people = await sql<{
      id: string;
      name: string;
      login_name: string | null;
      role_id: string | null;
      role_name: string | null;
      owner: unknown;
      source: string | null;
      first_login_at: unknown;
      last_seen_at: unknown;
      contact_email: string | null;
      access_expires: unknown;
      access_used: unknown;
    }>`
      select u.id, u.name, m.login_name, m.role_id, r.name as role_name, m.source,
        exists(select 1 from app_admin a where a.user_id = u.id) as owner,
        p.first_login_at, p.last_seen_at, p.contact_email,
        t.expires_at as access_expires, t.used_at as access_used
      from "user" u
      left join app_user_role m on m.user_id = u.id
      left join app_role r on r.id = m.role_id
      left join app_profile p on p.user_id = u.id
      left join app_temp_access t on t.user_id = u.id
      order by u.name
    `;
    const byRole = new Map<string, string[]>();
    for (const grant of grants) {
      const list = byRole.get(grant.role_id) ?? [];
      list.push(grant.permission_key);
      byRole.set(grant.role_id, list);
    }
    return {
      isAdmin: true as const,
      owner: profile.isAdmin,
      email: profile.email || ADMIN_EMAIL,
      loginName: profile.loginName || "admin",
      displayName: profile.displayName,
      contactEmail: profile.contactEmail,
      mustChangePassword: profile.mustChangePassword,
      sessionTtl: empty.sessionTtl,
      actorPermissions: profile.permissions,
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        fixed: flag(role.fixed),
        locked: role.id === "admin",
        permissions: role.id === "admin" ? permissions.map((item) => item.key) : (byRole.get(role.id) ?? []),
      })),
      permissions,
      users: people.map((person) => ({
        id: person.id,
        name: person.name,
        loginName: person.login_name ?? "",
        roleId: person.role_id ?? "",
        roleName: person.role_name ?? "Sin rol",
        owner: flag(person.owner),
        source: person.source ?? "local",
        firstLoginAt: epoch(person.first_login_at),
        lastSeenAt: epoch(person.last_seen_at),
        email: person.contact_email ?? "",
        // Acceso temporal por correo: pendiente de usar, ya usado (falta cambiar la contraseña) o vencido.
        access:
          person.access_expires == null
            ? null
            : {
                expiresAt: Number(person.access_expires),
                state:
                  person.access_used != null
                    ? ("used" as const)
                    : Number(person.access_expires) <= Date.now()
                      ? ("expired" as const)
                      : ("pending" as const),
              },
      })),
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        label: source.label,
        enabled: flag(source.enabled),
      })),
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        enabled: flag(plugin.enabled),
        builtIn: flag(plugin.built_in),
      })),
      indexed: Number(count[0]?.n ?? 0),
      engines: empty.engines,
    };
  });

export const markPasswordChanged = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    // Un usuario que entró con la contraseña temporal del correo.
    const { clearTempAccess } = await import("@/server/temp-access");
    if (!(await clearTempAccess(sql, context.userId))) return { ok: false as const };
    if (await isAdmin(sql, context.userId)) {
      await sql`update app_admin set must_change_password = false where user_id = ${context.userId}`;
    }
    return { ok: true as const };
  });

export const setRolePermission = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ roleId: z.string().min(1).max(48), key: z.string().min(1).max(40), granted: z.boolean() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "roles.manage")) return { ok: false as const };
    if (data.roleId === "admin") return { ok: false as const };
    const roles = await sql<{ id: string }>`select id from app_role where id = ${data.roleId} limit 1`;
    if (!roles[0]) return { ok: false as const };
    if (data.granted) {
      await sql`
        insert into app_role_permission (role_id, permission_key)
        values (${data.roleId}, ${data.key})
        on conflict do nothing
      `;
    } else {
      await sql`delete from app_role_permission where role_id = ${data.roleId} and permission_key = ${data.key}`;
    }
    await writeLog(
      sql,
      actor.loginName || actor.displayName,
      "Roles",
      `${data.granted ? "Activa" : "Quita"} ${data.key} en ${data.roleId}`,
    );
    return { ok: true as const };
  });

export const setPluginEnabled = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(40), enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "plugins.manage")) return { ok: false as const };
    await sql`update app_plugin set enabled = ${data.enabled} where id = ${data.id}`;
    return { ok: true as const };
  });

export const setSourceEnabled = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(40), enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "sources.manage")) return { ok: false as const };
    await sql`update app_source set enabled = ${data.enabled} where id = ${data.id}`;
    return { ok: true as const };
  });

export const listPlugins = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const sql = await sqlClient();
    const plugins = await sql<{ id: string; enabled: unknown }>`select id, enabled from app_plugin`;
    return Object.fromEntries(plugins.map((plugin) => [plugin.id, flag(plugin.enabled)]));
  } catch {
    return {} as Record<string, boolean>;
  }
});

export const probeSources = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "sources.manage")) return { elastic: null, bucket: null };
    const [elastic, bucket] = await Promise.all([probeElastic(), probeBucket()]);
    return { elastic, bucket };
  });

export const syncDocuments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ docs: z.array(docSchema).max(300) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const sources = await sql<{ enabled: unknown }>`select enabled from app_source where id = 'documents' limit 1`;
    if (sources[0] && !flag(sources[0].enabled)) return { indexed: 0, elastic: false };
    await sql`delete from doc_index where user_id = ${context.userId}`;
    for (const doc of data.docs) {
      await sql`
        insert into doc_index (user_id, doc_id, title, kind, portfolio_id, body, links_json, updated_at)
        values (
          ${context.userId},
          ${doc.id},
          ${doc.title},
          ${doc.kind},
          ${doc.portfolioId},
          ${doc.body},
          ${JSON.stringify(doc.links)},
          now()
        )
      `;
    }
    const mirror = await mirrorToElastic(context.userId, data.docs as IndexDoc[]);
    return { indexed: data.docs.length, elastic: mirror.ok };
  });

export const searchDocuments = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ q: z.string().max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const q = data.q.trim();
    if (!q) return { hits: [] as { id: string; title: string; kind: string }[], engine: documentEngine() };
    const elasticHits = await searchElastic(context.userId, q);
    if (elasticHits) return { hits: elasticHits, engine: "elasticsearch" as const };
    const term = likeTerm(q);
    const hits = await sql<{ doc_id: string; title: string; kind: string }>`
      select doc_id, title, kind from doc_index
      where user_id = ${context.userId}
        and (title ilike ${term} or body ilike ${term} or links_json ilike ${term})
      order by title
      limit 20
    `;
    return {
      hits: hits.map((hit) => ({ id: hit.doc_id, title: hit.title, kind: hit.kind })),
      engine: "postgres" as const,
    };
  });

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userInput = z.object({
  name: z.string().trim().min(1).max(80),
  username: z.string().trim().min(1).max(32),
  email: z.string().trim().min(1).max(120),
  roleId: z.string().min(1).max(48),
});

/**
 * Resultado de crear un usuario o reenviarle el acceso: si el correo salió, o
 * el enlace de un solo uso para entregárselo a mano (sin correo configurado,
 * o si el envío falló). Ver `server/temp-access.ts`.
 */
type AccessOutcome = { mailed: true; expiresAt: number } | { mailed: false; link: string; expiresAt: number; reason: string };

function outcome(result: Awaited<ReturnType<typeof import("@/server/temp-access").issueAccess>>): AccessOutcome {
  return result.mailed
    ? { mailed: true, expiresAt: result.expiresAt }
    : { mailed: false, link: result.link, expiresAt: result.expiresAt, reason: result.reason };
}

export const createVaultUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => userInput.parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "users.create")) return { ok: false as const, error: "Sin permiso para crear usuarios." };
    const email = emailForUsername(data.username);
    if (!email) return { ok: false as const, error: "El usuario solo admite letras, números, punto, guion y guion bajo." };
    if (!emailPattern.test(data.email)) return { ok: false as const, error: "El correo no es válido." };
    const role = await sql<{ id: string }>`select id from app_role where id = ${data.roleId} limit 1`;
    if (!role[0]) return { ok: false as const, error: "Ese rol no existe." };
    const login = data.username.trim().toLowerCase();
    const taken = await sql<{ user_id: string }>`select user_id from app_user_role where login_name = ${login} limit 1`;
    if (taken[0]) return { ok: false as const, error: "Ese usuario ya existe." };
    const auth = await (await import("@/lib/auth/server")).getAuth();
    const { issueAccess, temporaryPassword } = await import("@/server/temp-access");
    try {
      // Una contraseña que nadie conoce; la de verdad la pone `issueAccess`.
      await auth.api.signUpEmail({
        body: { name: data.name.trim(), email, password: `${temporaryPassword()}${temporaryPassword()}` },
        headers: await authHeaders(),
      });
    } catch {
      return { ok: false as const, error: "No se pudo crear el usuario." };
    }
    const created = await sql<{ id: string }>`select id from "user" where email = ${email} limit 1`;
    const id = created[0]?.id;
    if (!id) return { ok: false as const, error: "No se pudo crear el usuario." };
    await sql`delete from "session" where "userId" = ${id}`;
    await sql`
      insert into app_user_role (user_id, role_id, login_name)
      values (${id}, ${data.roleId}, ${login})
    `;
    await sql`
      insert into app_profile (user_id, contact_email) values (${id}, ${data.email})
      on conflict (user_id) do update set contact_email = excluded.contact_email
    `;
    await writeLog(sql, actor.loginName || actor.displayName, "Usuarios", `Crea a ${login}`);
    const access = await issueAccess(sql, id, { resent: false });
    return { ok: true as const, access: outcome(access) };
  });

/** Nueva contraseña temporal y correo de acceso, p. ej. si el anterior venció o no llegó. */
export const resendVaultAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ userId: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "users.update")) return { ok: false as const, error: "Sin permiso para actualizar usuarios." };
    const rows = await sql<{ login_name: string | null; source: string | null; owner: unknown; credential: unknown }>`
      select m.login_name, m.source,
        exists(select 1 from app_admin a where a.user_id = u.id) as owner,
        exists(select 1 from "account" c where c."userId" = u.id and c."providerId" = 'credential') as credential
      from "user" u left join app_user_role m on m.user_id = u.id
      where u.id = ${data.userId} limit 1
    `;
    const row = rows[0];
    if (!row) return { ok: false as const, error: "Ese usuario no está." };
    if (flag(row.owner)) return { ok: false as const, error: "El administrador inicial cambia su contraseña desde su cuenta." };
    if ((row.source && row.source !== "local") || !flag(row.credential)) {
      return { ok: false as const, error: "Esa cuenta entra con un proveedor externo: no tiene contraseña de Grafito." };
    }
    const { issueAccess } = await import("@/server/temp-access");
    const access = await issueAccess(sql, data.userId, { resent: true });
    await writeLog(sql, actor.loginName || actor.displayName, "Usuarios", `Reenvía el acceso a ${row.login_name ?? data.userId}`);
    return { ok: true as const, access: outcome(access) };
  });

export const updateVaultUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        userId: z.string().min(1).max(80),
        name: z.string().trim().min(1).max(80),
        roleId: z.string().min(1).max(48),
        email: z.string().trim().max(120),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "users.update")) return { ok: false as const, error: "Sin permiso para actualizar usuarios." };
    if (data.email && !emailPattern.test(data.email)) return { ok: false as const, error: "El correo no es válido." };
    const current = await sql<{ role_id: string | null; owner: unknown }>`
      select m.role_id, exists(select 1 from app_admin a where a.user_id = u.id) as owner
      from "user" u
      left join app_user_role m on m.user_id = u.id
      where u.id = ${data.userId}
      limit 1
    `;
    const row = current[0];
    if (!row) return { ok: false as const, error: "Ese usuario no está." };
    if (flag(row.owner) && data.roleId !== "admin") {
      return { ok: false as const, error: "El administrador inicial conserva ese rol." };
    }
    if (row.role_id === "admin" && data.roleId !== "admin") {
      const count = await sql<{ n: number }>`select count(*)::int as n from app_user_role where role_id = 'admin'`;
      if (Number(count[0]?.n ?? 0) <= 1) {
        return { ok: false as const, error: "Tiene que quedar al menos un administrador." };
      }
    }
    const role = await sql<{ id: string }>`select id from app_role where id = ${data.roleId} limit 1`;
    if (!role[0]) return { ok: false as const, error: "Ese rol no existe." };
    await sql`update "user" set name = ${data.name.trim()}, "updatedAt" = now() where id = ${data.userId}`;
    await sql`update app_user_role set role_id = ${data.roleId} where user_id = ${data.userId}`;
    const contact = data.email || null;
    await sql`
      insert into app_profile (user_id, contact_email) values (${data.userId}, ${contact})
      on conflict (user_id) do update set contact_email = excluded.contact_email
    `;
    await writeLog(sql, actor.loginName || actor.displayName, "Usuarios", `Actualiza a ${data.name.trim()}`);
    return { ok: true as const };
  });

export const deleteVaultUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ userId: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "users.delete")) return { ok: false as const, error: "Sin permiso para eliminar usuarios." };
    if (data.userId === context.userId) return { ok: false as const, error: "No puedes eliminarte a ti mismo." };
    const current = await sql<{ role_id: string | null; owner: unknown; name: string }>`
      select u.name, m.role_id, exists(select 1 from app_admin a where a.user_id = u.id) as owner
      from "user" u
      left join app_user_role m on m.user_id = u.id
      where u.id = ${data.userId}
      limit 1
    `;
    const row = current[0];
    if (!row) return { ok: false as const, error: "Ese usuario no está." };
    if (flag(row.owner)) return { ok: false as const, error: "El administrador inicial no se elimina." };
    if (row.role_id === "admin") {
      const count = await sql<{ n: number }>`select count(*)::int as n from app_user_role where role_id = 'admin'`;
      if (Number(count[0]?.n ?? 0) <= 1) {
        return { ok: false as const, error: "Tiene que quedar al menos un administrador." };
      }
    }
    await removeUserFiles(sql, data.userId);
    await sql`delete from "user" where id = ${data.userId}`;
    await writeLog(sql, actor.loginName || actor.displayName, "Usuarios", `Elimina a ${row.name}`);
    return { ok: true as const };
  });

export const createRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ name: z.string().trim().min(2).max(40) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "roles.manage")) return { ok: false as const, error: "Sin permiso para crear roles." };
    const name = data.name.trim();
    const clash = await sql<{ id: string }>`select id from app_role where lower(name) = lower(${name}) limit 1`;
    if (clash[0]) return { ok: false as const, error: "Ya hay un rol con ese nombre." };
    const id = roleSlug(name);
    await sql`insert into app_role (id, name, fixed) values (${id}, ${name}, false)`;
    await sql`
      insert into app_role_permission (role_id, permission_key)
      values (${id}, 'notes.read')
      on conflict do nothing
    `;
    await writeLog(sql, actor.loginName || actor.displayName, "Roles", `Crea el rol ${name}`);
    return { ok: true as const, id };
  });

export const renameRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ id: z.string().min(1).max(48), name: z.string().trim().min(2).max(40) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "roles.manage")) return { ok: false as const, error: "Sin permiso para renombrar roles." };
    const role = await sql<{ fixed: unknown }>`select fixed from app_role where id = ${data.id} limit 1`;
    if (!role[0]) return { ok: false as const, error: "Ese rol no está." };
    if (flag(role[0].fixed)) return { ok: false as const, error: "Los roles predeterminados no se renombran." };
    const name = data.name.trim();
    const clash = await sql<{ id: string }>`
      select id from app_role where lower(name) = lower(${name}) and id <> ${data.id} limit 1
    `;
    if (clash[0]) return { ok: false as const, error: "Ya hay un rol con ese nombre." };
    await sql`update app_role set name = ${name} where id = ${data.id}`;
    await writeLog(sql, actor.loginName || actor.displayName, "Roles", `Renombra un rol a ${name}`);
    return { ok: true as const };
  });

export const deleteRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: z.string().min(1).max(48) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "roles.manage")) return { ok: false as const, error: "Sin permiso para eliminar roles." };
    const role = await sql<{ fixed: unknown; name: string }>`select fixed, name from app_role where id = ${data.id} limit 1`;
    if (!role[0]) return { ok: false as const, error: "Ese rol no está." };
    if (flag(role[0].fixed)) return { ok: false as const, error: "Los roles predeterminados no se eliminan." };
    const used = await sql<{ n: number }>`select count(*)::int as n from app_user_role where role_id = ${data.id}`;
    if (Number(used[0]?.n ?? 0) > 0) {
      return { ok: false as const, error: "Hay usuarios con este rol. Cámbiales el rol antes." };
    }
    await sql`delete from app_role where id = ${data.id}`;
    await writeLog(sql, actor.loginName || actor.displayName, "Roles", `Elimina el rol ${role[0].name}`);
    return { ok: true as const };
  });

export const systemSnapshot = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "monitor.view")) return { ok: false as const };
    const os = await import("node:os");
    const sample = () =>
      os.cpus().map((cpu) => {
        const times = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
        return { idle: cpu.times.idle, total: times };
      });
    const before = sample();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const after = sample();
    let idle = 0;
    let total = 0;
    for (let index = 0; index < after.length; index += 1) {
      idle += (after[index]?.idle ?? 0) - (before[index]?.idle ?? 0);
      total += (after[index]?.total ?? 0) - (before[index]?.total ?? 0);
    }
    const cpu = total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memory = process.memoryUsage();
    return {
      ok: true as const,
      hostname: os.hostname(),
      cpu,
      cores: os.cpus().length,
      load: os.loadavg().map((value) => Math.round(value * 100) / 100),
      memTotal,
      memFree,
      uptime: Math.round(os.uptime()),
      rss: memory.rss,
    };
  });

export const systemLogs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const actor = await readUserProfile(sql, context.userId);
    if (!allows(actor, "monitor.view")) {
      return { ok: false as const, rows: [] as { id: string; at: string; actor: string; area: string; message: string }[] };
    }
    const rows = await sql<{ id: string; at: string; actor: string; area: string; message: string }>`
      select id, at::text as at, actor, area, message
      from app_log
      order by at desc
      limit 80
    `;
    return {
      ok: true as const,
      rows: rows.map((row) => ({
        id: row.id,
        at: String(row.at),
        actor: row.actor,
        area: row.area,
        message: row.message,
      })),
    };
  });
