import type { Sql } from "../db";

/**
 * Proveedores externos de inicio de sesión (solo servidor), guardados en
 * `auth_provider` (migración 0007). Se configuran desde Administración →
 * Autenticación; los secretos nunca salen del servidor sin enmascarar.
 */

export type ProviderId = "ldap" | "google" | "github" | "microsoft" | "sso";
export const PROVIDER_IDS: ProviderId[] = ["ldap", "google", "github", "microsoft", "sso"];
export const OAUTH_IDS = ["google", "github", "microsoft"] as const;
export type OAuthId = (typeof OAUTH_IDS)[number];

export type LdapConfig = {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** `{{username}}` se reemplaza por lo que escribe la persona (escapado). */
  userFilter: string;
  nameAttr: string;
  emailAttr: string;
  startTls: boolean;
  /** Acepta certificados no verificados (solo para pruebas). */
  allowInsecureTls: boolean;
};

export type OAuthConfig = { clientId: string; clientSecret: string; tenantId: string };

export type SsoConfig = {
  label: string;
  /** Emisor OIDC, p. ej. `https://keycloak.example.com/realms/grafito`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

export type ProviderConfig = {
  ldap: LdapConfig;
  google: OAuthConfig;
  github: OAuthConfig;
  microsoft: OAuthConfig;
  sso: SsoConfig;
};

export const DEFAULTS: ProviderConfig = {
  ldap: {
    url: "ldap://",
    bindDn: "",
    bindPassword: "",
    baseDn: "",
    userFilter: "(uid={{username}})",
    nameAttr: "cn",
    emailAttr: "mail",
    startTls: false,
    allowInsecureTls: false,
  },
  google: { clientId: "", clientSecret: "", tenantId: "" },
  github: { clientId: "", clientSecret: "", tenantId: "" },
  microsoft: { clientId: "", clientSecret: "", tenantId: "common" },
  sso: { label: "SSO", issuer: "", clientId: "", clientSecret: "", scopes: "openid profile email" },
};

/** Campos secretos: se guardan, pero al navegador llegan vacíos. */
const SECRETS = ["bindPassword", "clientSecret"] as const;

export type ProviderRow<K extends ProviderId = ProviderId> = {
  id: K;
  enabled: boolean;
  config: ProviderConfig[K];
  defaultRole: string;
  allowedDomains: string[];
  updatedAt: string;
};

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function parseConfig<K extends ProviderId>(id: K, raw: string): ProviderConfig[K] {
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderConfig[K]>;
    return { ...DEFAULTS[id], ...parsed };
  } catch {
    return { ...DEFAULTS[id] };
  }
}

export function parseDomains(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export async function readProviders(sql: Sql): Promise<ProviderRow[]> {
  const rows = await sql<{
    id: string;
    enabled: unknown;
    config: string;
    default_role: string;
    allowed_domains: string;
    updated_at: unknown;
  }>`select id, enabled, config, default_role, allowed_domains, updated_at from auth_provider`;
  return PROVIDER_IDS.map((id) => {
    const row = rows.find((item) => item.id === id);
    return {
      id,
      enabled: flag(row?.enabled),
      config: parseConfig(id, row?.config ?? "{}"),
      defaultRole: row?.default_role ?? "miembro",
      allowedDomains: parseDomains(row?.allowed_domains ?? ""),
      updatedAt: row ? new Date(String(row.updated_at)).toISOString() : "",
    } as ProviderRow;
  });
}

export async function readProvider<K extends ProviderId>(sql: Sql, id: K): Promise<ProviderRow<K>> {
  return (await readProviders(sql)).find((row) => row.id === id) as ProviderRow<K>;
}

/** Copia para el navegador: secretos vacíos y `hasSecret` para saber si hay uno guardado. */
export function maskProvider(row: ProviderRow): ProviderRow & { hasSecret: boolean } {
  const config = { ...row.config } as Record<string, unknown>;
  let hasSecret = false;
  for (const key of SECRETS) {
    if (typeof config[key] === "string") {
      if (config[key]) hasSecret = true;
      config[key] = "";
    }
  }
  return { ...row, config: config as ProviderRow["config"], hasSecret };
}

/**
 * Aplica lo que llega del formulario sobre lo guardado: solo campos conocidos y
 * con su tipo, y un secreto vacío conserva el que ya había.
 */
export function mergeConfig<K extends ProviderId>(
  id: K,
  current: ProviderConfig[K],
  input: Record<string, unknown>,
): ProviderConfig[K] {
  const defaults = DEFAULTS[id] as Record<string, unknown>;
  const merged = { ...defaults, ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaults) || typeof value !== typeof defaults[key]) continue;
    if ((SECRETS as readonly string[]).includes(key) && value === "") continue;
    merged[key] = typeof value === "string" ? value.trim() : value;
  }
  return merged as ProviderConfig[K];
}

/** Guarda la configuración. Un secreto vacío conserva el que ya había. */
export async function writeProvider(
  sql: Sql,
  id: ProviderId,
  input: { enabled: boolean; config: Record<string, unknown>; defaultRole: string; allowedDomains: string },
): Promise<void> {
  const current = await readProvider(sql, id);
  const config = JSON.stringify(mergeConfig(id, current.config, input.config));
  const domains = parseDomains(input.allowedDomains).join(", ");
  await sql`
    insert into auth_provider (id, enabled, config, default_role, allowed_domains, updated_at)
    values (${id}, ${input.enabled}, ${config}, ${input.defaultRole}, ${domains}, now())
    on conflict (id) do update set
      enabled = excluded.enabled,
      config = excluded.config,
      default_role = excluded.default_role,
      allowed_domains = excluded.allowed_domains,
      updated_at = now()
  `;
}

/** El correo pasa el filtro de dominios del proveedor (vacío = cualquiera). */
export function domainAllowed(row: Pick<ProviderRow, "allowedDomains">, email: string): boolean {
  if (row.allowedDomains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return row.allowedDomains.includes(domain);
}

/** Un proveedor está listo para mostrarse en el ingreso. */
export function providerReady(row: ProviderRow): boolean {
  if (!row.enabled) return false;
  if (row.id === "ldap") {
    const ldap = row.config as LdapConfig;
    return Boolean(ldap.url && ldap.url !== "ldap://" && ldap.baseDn);
  }
  if (row.id === "sso") {
    const sso = row.config as SsoConfig;
    return Boolean(sso.issuer && sso.clientId && sso.clientSecret);
  }
  const oauth = row.config as OAuthConfig;
  return Boolean(oauth.clientId && oauth.clientSecret);
}
