/**
 * Better Auth de Grafito (solo servidor). Usuario y contraseña locales, en la
 * misma base que el resto de la app: Postgres con `DATABASE_URL`, si no PGLite.
 * Además, los proveedores externos activados en Administración → Autenticación:
 * LDAP (`./ldap-plugin.server`), OAuth (Google, GitHub, Microsoft) y SSO por
 * OpenID Connect (p. ej. Keycloak).
 *
 * La instancia se construye a partir de esa configuración y se cachea; se
 * rehace sola cuando cambia (ver `getAuth`). Nunca importar desde código de
 * cliente: arrastra `pg` y los secretos.
 */
import { betterAuth, type GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, genericOAuth } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { ensureDbReady, getPglite, getSql } from "../db";
import { pgliteDialect } from "./pglite-dialect";
import { AUTH_COOKIE_PREFIX, SESSION_TOKEN_COOKIE } from "./cookies";
import { ldapPlugin } from "./ldap-plugin.server";
import {
  domainAllowed,
  providerReady,
  readProviders,
  type OAuthConfig,
  type ProviderRow,
  type SsoConfig,
} from "./providers.server";
import { provisionExternalUser, syncExternalEmail } from "./provision.server";

// Arranca (y comparte) la preparación de PGLite en cuanto carga este módulo.
void ensureDbReady();

const globalAuthRef = globalThis as typeof globalThis & {
  __grafitoAuthSecret__?: string;
  __grafitoAuthDatabase__?: Pool | { dialect: ReturnType<typeof pgliteDialect>; type: "postgres" };
  __grafitoAuth__?: { key: string; auth: Auth; checkedAt: number };
};

/**
 * Sin `BETTER_AUTH_SECRET`, un secreto por proceso. Vive en `globalThis` para
 * que un HMR no invalide las sesiones guardadas en PGLite.
 */
function processAuthSecret(): string {
  globalAuthRef.__grafitoAuthSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__grafitoAuthSecret__;
}

/** Variable de entorno; vacía o solo espacios cuenta como ausente. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

// El navegador puede mandar cualquiera de estos Origin para el mismo servidor;
// fiarse solo de `localhost` rechaza `127.0.0.1` con "Invalid origin".
const LOCAL_ORIGINS: string[] = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
];

const explicitBaseURL = env("BETTER_AUTH_URL");
const baseURL = explicitBaseURL ?? {
  allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
  protocol: "auto" as const,
  fallback: "http://localhost:8080",
};
// Otras direcciones por las que se entra al mismo servidor (su IP y su dominio,
// por ejemplo), separadas por comas. Sin ellas, Better Auth rechaza el ingreso
// con «Invalid origin» (ver `AccessGate`).
const extraOrigins: string[] = (env("BETTER_AUTH_TRUSTED_ORIGINS") ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const fixedOrigins: string[] = [
  ...(explicitBaseURL ? [explicitBaseURL] : []),
  ...extraOrigins,
  ...LOCAL_ORIGINS,
];

/**
 * El Origin de una petición hecha desde la misma dirección a la que va (la IP
 * del servidor, o el dominio de un proxy que conserva Host o manda
 * X-Forwarded-Host): no es de otro sitio, así que se acepta sin listarla.
 */
function sameSiteOrigin(request?: Request): string | null {
  const origin = request?.headers.get("origin");
  if (!origin) return null;
  const forwarded = request?.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwarded || request?.headers.get("host") || "").toLowerCase();
  try {
    return host && new URL(origin).host.toLowerCase() === host ? origin : null;
  } catch {
    return null;
  }
}

const trustedOrigins = (request?: Request) => [...fixedOrigins, sameSiteOrigin(request)];

/** Una sola conexión de Better Auth por proceso, aunque la instancia se rehaga. */
function database() {
  globalAuthRef.__grafitoAuthDatabase__ ??= env("DATABASE_URL")
    ? new Pool({ connectionString: env("DATABASE_URL") })
    : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };
  return globalAuthRef.__grafitoAuthDatabase__;
}

/** Proveedor externo del que viene la petición que crea un usuario, si lo hay. */
function externalProvider(context: GenericEndpointContext | null): string | null {
  const params = (context?.params ?? {}) as Record<string, string | undefined>;
  return params.providerId ?? params.id ?? null;
}

function buildAuth(providers: ProviderRow[]) {
  const ready = providers.filter(providerReady);
  const byId = new Map(ready.map((row) => [row.id, row]));
  const oauth = (id: "google" | "github" | "microsoft") => byId.get(id)?.config as OAuthConfig | undefined;
  const google = oauth("google");
  const github = oauth("github");
  const microsoft = oauth("microsoft");
  const sso = byId.get("sso")?.config as SsoConfig | undefined;

  return betterAuth({
    baseURL,
    secret: env("BETTER_AUTH_SECRET") ?? processAuthSecret(),
    database: database(),
    trustedOrigins,

    // Sin caché de cookie: el plazo de sesión de administración borra filas de
    // "session" en vivo, y una cookie cacheada dejaría al visitante dentro.
    session: { cookieCache: { enabled: false } },

    // minPasswordLength 4 para que el "admin" inicial sea una credencial válida.
    emailAndPassword: { enabled: true, minPasswordLength: 4, maxPasswordLength: 128 },

    socialProviders: {
      ...(google ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } } : {}),
      ...(github ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } } : {}),
      ...(microsoft
        ? {
            microsoft: {
              clientId: microsoft.clientId,
              clientSecret: microsoft.clientSecret,
              tenantId: microsoft.tenantId || "common",
            },
          }
        : {}),
    },

    // Un proveedor externo no se apropia de una cuenta existente solo porque
    // trae el mismo correo: cada cuenta externa nueva es un usuario nuevo.
    account: { accountLinking: { disableImplicitLinking: true } },

    databaseHooks: {
      // Acceso temporal por correo (`server/temp-access.ts`): la contraseña ya
      // se comprobó; si venció o ya se usó una vez, no se abre la sesión.
      session: {
        create: {
          before: async (session) => {
            const { claimTempAccess } = await import("@/server/temp-access");
            const state = await claimTempAccess(await getSql(), session.userId);
            if (state === "expired") throw new APIError("FORBIDDEN", { message: "TEMP_ACCESS_EXPIRED" });
            if (state === "used") throw new APIError("FORBIDDEN", { message: "TEMP_ACCESS_USED" });
          },
          // LDAP, OAuth o SSO: el correo de la cuenta es el de su proveedor.
          after: async (session) => {
            await syncExternalEmail(await getSql(), session.userId).catch(() => undefined);
          },
        },
      },
      user: {
        create: {
          // Filtro de dominios del proveedor (vacío = cualquiera).
          before: async (user, context) => {
            const provider = externalProvider(context);
            const row = provider ? byId.get(provider as ProviderRow["id"]) : undefined;
            if (row && !domainAllowed(row, user.email)) return false;
          },
          // Rol por defecto y nombre de usuario para quien llega por OAuth o SSO.
          after: async (user, context) => {
            const provider = externalProvider(context);
            const row = provider ? byId.get(provider as ProviderRow["id"]) : undefined;
            if (!row || row.id === "ldap") return;
            await provisionExternalUser(await getSql(), {
              userId: user.id,
              source: row.id,
              login: user.email.split("@")[0] ?? user.name,
              roleId: row.defaultRole,
            });
          },
        },
      },
    },

    // Cookies `__Host-` (Secure + Path=/ + sin Domain): ningún subdominio hermano
    // puede plantar una cookie con el mismo nombre. Los navegadores aceptan
    // Secure en http://localhost, así que el desarrollo local sigue funcionando.
    advanced: {
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
      cookies: {
        session_token: { name: SESSION_TOKEN_COOKIE },
        session_data: { name: `${AUTH_COOKIE_PREFIX}.session_data` },
        account_data: { name: `${AUTH_COOKIE_PREFIX}.account_data` },
        dont_remember: { name: `${AUTH_COOKIE_PREFIX}.dont_remember` },
      },
    },

    plugins: [
      ldapPlugin(),
      ...(sso
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "sso",
                  clientId: sso.clientId,
                  clientSecret: sso.clientSecret,
                  discoveryUrl: `${sso.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
                  scopes: sso.scopes.split(/\s+/).filter(Boolean),
                  pkce: true,
                },
              ],
            }),
          ]
        : []),
      // `Authorization: Bearer <token>` como alternativa a la cookie, para
      // navegadores donde la cookie Secure no llega (ver `./bearer`).
      bearer(),
      // Pasa los Set-Cookie de Better Auth a TanStack Start. Debe ir el último.
      tanstackStartCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

/** Cada cuánto se mira si cambió la configuración de proveedores. */
const RECHECK_MS = 5000;

/**
 * Instancia de Better Auth con los proveedores activos. Se rehace solo cuando
 * cambia su configuración; `invalidateAuth()` fuerza la comprobación.
 */
export async function getAuth(): Promise<Auth> {
  // El secreto de sesión no puede ser el de ejemplo público (ver `server/install-secrets.ts`).
  const { ensureInstallSecrets } = await import("@/server/install-secrets");
  ensureInstallSecrets();
  const cached = globalAuthRef.__grafitoAuth__;
  const now = Date.now();
  if (cached && now - cached.checkedAt < RECHECK_MS) return cached.auth;
  let providers: ProviderRow[] = [];
  try {
    providers = await readProviders(await getSql());
  } catch {
    /* sin la tabla todavía: solo usuario y contraseña */
  }
  const key = JSON.stringify(providers.filter(providerReady).map((row) => [row.id, row.updatedAt]));
  if (cached && cached.key === key) {
    cached.checkedAt = now;
    return cached.auth;
  }
  const auth = buildAuth(providers);
  globalAuthRef.__grafitoAuth__ = { key, auth, checkedAt: now };
  return auth;
}

export function invalidateAuth(): void {
  if (globalAuthRef.__grafitoAuth__) globalAuthRef.__grafitoAuth__.checkedAt = 0;
}
