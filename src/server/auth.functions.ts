import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { testConnection } from "@/lib/auth/ldap.server";
import {
  OAUTH_IDS,
  PROVIDER_IDS,
  maskProvider,
  mergeConfig,
  providerReady,
  readProvider,
  readProviders,
  writeProvider,
  type LdapConfig,
  type ProviderId,
  type SsoConfig,
} from "@/lib/auth/providers.server";
import { invalidateAuth } from "@/lib/auth/server";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";

/** Funciones de servidor de Administración → Autenticación, y lo que el ingreso necesita saber. */

const providerId = z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]);
const DENIED = { ok: false as const, error: "Sin permiso para configurar la autenticación." };

const LABELS: Record<ProviderId, string> = {
  ldap: "Directorio (LDAP)",
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  sso: "SSO",
};

async function manager(userId: string) {
  const sql = await requireLease(userId);
  const actor = await readUserProfile(sql, userId);
  return { sql, actor, ok: allows(actor, "auth.manage") };
}

/** URL pública de la app, para mostrar las direcciones de retorno que hay que registrar. */
async function publicOrigin(): Promise<string> {
  const explicit = process.env.BETTER_AUTH_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    if (request) return new URL(request.url).origin;
  } catch {
    /* fuera de una petición */
  }
  return "http://127.0.0.1:8080";
}

export const authState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ok } = await manager(context.userId);
    if (!ok) return { ok: false as const };
    const origin = await publicOrigin();
    const roles = await sql<{ id: string; name: string }>`select id, name from app_role order by name`;
    return {
      ok: true as const,
      providers: (await readProviders(sql)).map(maskProvider),
      roles,
      callbacks: {
        google: `${origin}/api/auth/callback/google`,
        github: `${origin}/api/auth/callback/github`,
        microsoft: `${origin}/api/auth/callback/microsoft`,
        sso: `${origin}/api/auth/oauth2/callback/sso`,
      },
    };
  });

export const saveAuthProvider = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        id: providerId,
        enabled: z.boolean(),
        config: z.record(z.string(), z.union([z.string().max(2000), z.boolean()])),
        defaultRole: z.string().min(1).max(48),
        allowedDomains: z.string().max(1000),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, actor, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    const role = await sql<{ id: string }>`select id from app_role where id = ${data.defaultRole} limit 1`;
    if (!role[0]) return { ok: false as const, error: "Ese rol no existe." };
    await writeProvider(sql, data.id, data);
    invalidateAuth();
    const saved = await readProvider(sql, data.id);
    await sql`
      insert into app_log (id, actor, area, message)
      values (${crypto.randomUUID()}, ${actor.loginName || actor.displayName}, 'Autenticación',
        ${`${data.enabled ? "Activa" : "Desactiva"} ${LABELS[data.id]}`})
    `;
    return {
      ok: true as const,
      provider: maskProvider(saved),
      warning: data.enabled && !providerReady(saved) ? "Activado, pero faltan datos: no aparecerá en el ingreso." : "",
    };
  });

/** Prueba LDAP con lo que hay en el formulario (sin guardar). */
export const testLdap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        config: z.record(z.string(), z.union([z.string().max(2000), z.boolean()])),
        probeUser: z.string().max(120),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ok } = await manager(context.userId);
    if (!ok) return DENIED;
    const current = await readProvider(sql, "ldap");
    const config = mergeConfig("ldap", current.config, data.config) as LdapConfig;
    if (!config.url || config.url === "ldap://" || !config.baseDn) {
      return { ok: false as const, error: "Falta la URL del servidor o la base de búsqueda." };
    }
    try {
      return { ok: true as const, message: await testConnection(config, data.probeUser) };
    } catch (error) {
      return { ok: false as const, error: `No se pudo conectar: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

/** Prueba el emisor OIDC leyendo su documento de descubrimiento. */
export const testSso = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ issuer: z.string().url().max(500) }).parse(input))
  .handler(async ({ context, data }) => {
    const { ok } = await manager(context.userId);
    if (!ok) return DENIED;
    const url = `${data.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { ok: false as const, error: `El emisor respondió ${response.status}.` };
      const doc = (await response.json()) as { issuer?: string; authorization_endpoint?: string };
      return {
        ok: true as const,
        message: `Emisor correcto: ${doc.issuer ?? "?"} · inicio de sesión en ${doc.authorization_endpoint ?? "?"}`,
      };
    } catch (error) {
      return { ok: false as const, error: `No se pudo leer ${url}: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

/** Qué formas de entrar ofrece el ingreso. Público: no requiere sesión ni revela configuración. */
export const authMethods = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { getSql } = await import("@/lib/db");
    const rows = (await readProviders(await getSql())).filter(providerReady);
    const sso = rows.find((row) => row.id === "sso");
    return {
      ldap: rows.some((row) => row.id === "ldap"),
      oauth: rows
        .filter((row): row is typeof row & { id: (typeof OAUTH_IDS)[number] } => (OAUTH_IDS as readonly string[]).includes(row.id))
        .map((row) => ({ id: row.id, label: LABELS[row.id] })),
      sso: sso ? { label: (sso.config as SsoConfig).label || LABELS.sso } : null,
    };
  } catch {
    return { ldap: false, oauth: [] as { id: "google" | "github" | "microsoft"; label: string }[], sso: null };
  }
});
