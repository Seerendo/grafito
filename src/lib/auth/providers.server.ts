import type { Sql } from "../db";

/**
 * Server-only external authentication provider settings in auth_provider, migration 0007.
 * Administration configures them; mask all secrets before browser responses.
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
  /** Replace the username placeholder with escaped user input. */
  userFilter: string;
  nameAttr: string;
  emailAttr: string;
  startTls: boolean;
  /** Allow unverified certificates for testing only. */
  allowInsecureTls: boolean;
};

export type OAuthConfig = { clientId: string; clientSecret: string; tenantId: string };

export type SsoConfig = {
  label: string;
  /** OIDC issuer, for example a Keycloak realm URL. */
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

/** Persist secret fields but send empty values to the browser. */
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

/** Browser-safe copy with empty secrets and hasSecret flags. */
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
 * Merge known, correctly typed form fields into stored settings. Empty secrets preserve
 * existing values.
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

/** Save settings while preserving existing secrets when inputs are empty. */
export async function writeProvider(
  sql: Sql,
  id: ProviderId,
  input: {
    enabled: boolean;
    config: Record<string, unknown>;
    defaultRole: string;
    allowedDomains: string;
  },
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

/** Whether email passes the provider's domain filter; empty allows any domain. */
export function domainAllowed(row: Pick<ProviderRow, "allowedDomains">, email: string): boolean {
  if (row.allowedDomains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return row.allowedDomains.includes(domain);
}

/** Whether the provider is ready to appear on the sign-in screen. */
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
