/**
 * Server-only Better Auth configuration shares Postgres or PGLite with the application.
 * Supports local credentials and configured LDAP, OAuth and OIDC providers. Cache the instance
 * and rebuild when settings change. Never import into browser code because it includes pg and
 * secrets.
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

// Start and share PGLite initialization when this module loads.
void ensureDbReady();

const globalAuthRef = globalThis as typeof globalThis & {
  __grafitoAuthSecret__?: string;
  __grafitoAuthDatabase__?: Pool | { dialect: ReturnType<typeof pgliteDialect>; type: "postgres" };
  __grafitoAuth__?: { key: string; auth: Auth; checkedAt: number };
};

/** Fallback per-process secret stored on globalThis so HMR preserves PGLite sessions. */
function processAuthSecret(): string {
  globalAuthRef.__grafitoAuthSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__grafitoAuthSecret__;
}

/** Read an environment variable, treating empty or whitespace-only values as absent. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

// Accept localhost and loopback origins used for the same local server.
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
// Additional comma-separated server addresses prevent Invalid origin failures; see AccessGate.
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
 * Accept a request origin matching its destination through Host or X-Forwarded-Host without
 * requiring a separate trusted-origin entry.
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

/** Reuse one Better Auth connection pool per process even when rebuilding the auth instance. */
function database() {
  globalAuthRef.__grafitoAuthDatabase__ ??= env("DATABASE_URL")
    ? // Small pool for sessions and sign-ins; application data uses db.ts.
      new Pool({ connectionString: env("DATABASE_URL"), max: 5 })
    : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };
  return globalAuthRef.__grafitoAuthDatabase__;
}

/** External provider responsible for an account-creation request, if any. */
function externalProvider(context: GenericEndpointContext | null): string | null {
  const params = (context?.params ?? {}) as Record<string, string | undefined>;
  return params.providerId ?? params.id ?? null;
}

function buildAuth(providers: ProviderRow[]) {
  const ready = providers.filter(providerReady);
  const byId = new Map(ready.map((row) => [row.id, row]));
  const oauth = (id: "google" | "github" | "microsoft") =>
    byId.get(id)?.config as OAuthConfig | undefined;
  const google = oauth("google");
  const github = oauth("github");
  const microsoft = oauth("microsoft");
  const sso = byId.get("sso")?.config as SsoConfig | undefined;

  return betterAuth({
    baseURL,
    secret: env("BETTER_AUTH_SECRET") ?? processAuthSecret(),
    database: database(),
    trustedOrigins,

    // Disable cookie caching because administrators revoke sessions by deleting rows immediately.
    session: { cookieCache: { enabled: false } },

    // Minimum password length four permits the initial admin credential.
    emailAndPassword: { enabled: true, minPasswordLength: 4, maxPasswordLength: 128 },

    socialProviders: {
      ...(google
        ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } }
        : {}),
      ...(github
        ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } }
        : {}),
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

    // External providers cannot claim existing accounts merely by supplying the same email; newly provisioned identities remain separate.
    account: { accountLinking: { disableImplicitLinking: true } },

    databaseHooks: {
      // After password verification, reject temporary email access that expired or was already used; see server/temp-access.ts.
      session: {
        create: {
          before: async (session) => {
            const { claimTempAccess } = await import("@/server/temp-access");
            const state = await claimTempAccess(await getSql(), session.userId);
            if (state === "expired")
              throw new APIError("FORBIDDEN", { message: "TEMP_ACCESS_EXPIRED" });
            if (state === "used") throw new APIError("FORBIDDEN", { message: "TEMP_ACCESS_USED" });
          },
          // Refresh provider-controlled email and audit successful sign-in. Missing audit schema or audit failures must not prevent the session from opening.
          after: async (session) => {
            const sql = await getSql();
            await syncExternalEmail(sql, session.userId).catch(() => undefined);
            try {
              const { recordAudit } = await import("@/server/audit");
              const rows = await sql<{ name: string; login_name: string | null }>`
                select u.name, m.login_name
                from "user" u
                left join app_user_role m on m.user_id = u.id
                where u.id = ${session.userId}
                limit 1
              `;
              const address =
                "ipAddress" in session && typeof session.ipAddress === "string"
                  ? session.ipAddress
                  : "";
              await recordAudit(sql, {
                actorId: session.userId,
                actorName: rows[0]?.login_name || rows[0]?.name || "",
                action: "sign_in",
                outcome: "ok",
                area: "Sesión",
                detail: "Ingresa",
                ip: address,
              });
            } catch (error) {
              console.error("No se pudo anotar el ingreso.", error);
            }
          },
        },
      },
      user: {
        create: {
          // Provider email-domain filter; empty permits any domain.
          before: async (user, context) => {
            const provider = externalProvider(context);
            const row = provider ? byId.get(provider as ProviderRow["id"]) : undefined;
            if (row && !domainAllowed(row, user.email)) return false;
          },
          // Assign default role and username to OAuth/SSO accounts.
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

    // Use __Host- cookies with Secure, Path=/ and no Domain to prevent sibling-subdomain cookie injection. Browsers permit Secure cookies on localhost HTTP for development.
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
      // Bearer authentication supports browsers unable to retain Secure cookies; see bearer.ts.
      bearer(),
      // Forward Better Auth Set-Cookie headers to TanStack Start; this plugin must be last.
      tanstackStartCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

/** Provider-settings refresh interval. */
const RECHECK_MS = 5000;

/**
 * Cache Better Auth with active providers and rebuild only after configuration changes.
 * invalidateAuth forces a refresh.
 */
export async function getAuth(): Promise<Auth> {
  // Never use the public example session secret; see server/install-secrets.ts.
  const { ensureInstallSecrets } = await import("@/server/install-secrets");
  ensureInstallSecrets();
  const cached = globalAuthRef.__grafitoAuth__;
  const now = Date.now();
  if (cached && now - cached.checkedAt < RECHECK_MS) return cached.auth;
  let providers: ProviderRow[] = [];
  try {
    providers = await readProviders(await getSql());
  } catch {
    /* Provider table unavailable; use local credentials only. */
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
