import { lookup } from "node:dns/promises";
import type { Sql } from "@/lib/db";
import { checkTarget, hostListed, type TargetCheck } from "@/domain/mail/hosts";
import { parseMailPolicy, type MailPolicy } from "@/domain/mail/policy";
import { decrypt, encrypt } from "@/server/crypto";

/**
 * Email module settings shared by the web app and the mail-sync worker: the administrator's
 * policy, institutional profiles, OAuth applications, account secrets and where an IMAP
 * connection may go.
 */

const POLICY_KEY = "mail_policy";

export async function readMailPolicy(sql: Sql): Promise<MailPolicy> {
  const rows = await sql<{ value: string }>`
    select value from app_setting where key = ${POLICY_KEY} limit 1
  `;
  try {
    return parseMailPolicy(rows[0] ? JSON.parse(rows[0].value) : {});
  } catch {
    return parseMailPolicy({});
  }
}

export async function writeMailPolicy(sql: Sql, policy: MailPolicy): Promise<MailPolicy> {
  const clean = parseMailPolicy(policy);
  await sql`
    insert into app_setting (key, value) values (${POLICY_KEY}, ${JSON.stringify(clean)})
    on conflict (key) do update set value = excluded.value
  `;
  return clean;
}

export type MailProfile = {
  id: string;
  name: string;
  provider: "imap";
  host: string;
  port: number;
  tls: boolean;
  domains: string[];
};

export async function listProfiles(sql: Sql): Promise<MailProfile[]> {
  const rows = await sql<{
    id: string;
    name: string;
    host: string;
    port: number;
    tls: unknown;
    domains: string;
  }>`select id, name, host, port, tls, domains from mail_profile order by name`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: "imap",
    host: row.host,
    port: Number(row.port),
    tls: row.tls === true || row.tls === "t",
    domains: row.domains
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  }));
}

export async function saveProfile(sql: Sql, profile: MailProfile): Promise<void> {
  const now = Date.now();
  await sql`
    insert into mail_profile (id, name, provider, host, port, tls, domains, created_at, updated_at)
    values (${profile.id}, ${profile.name}, 'imap', ${profile.host.trim().toLowerCase()}, ${profile.port},
      ${profile.tls}, ${profile.domains.join(",")}, ${now}, ${now})
    on conflict (id) do update set name = excluded.name, host = excluded.host, port = excluded.port,
      tls = excluded.tls, domains = excluded.domains, updated_at = excluded.updated_at
  `;
}

export async function deleteProfile(sql: Sql, id: string): Promise<void> {
  await sql`delete from mail_profile where id = ${id}`;
}

/** OAuth application of a provider, set by an administrator. The secret never leaves the server. */
export type OAuthApp = { clientId: string; clientSecret: string; tenant: string };

function appKey(provider: "gmail" | "microsoft"): string {
  return `mail_oauth_${provider}`;
}

export async function readOAuthApp(
  sql: Sql,
  provider: "gmail" | "microsoft",
): Promise<OAuthApp | null> {
  const rows = await sql<{ value: string }>`
    select value from app_setting where key = ${appKey(provider)} limit 1
  `;
  if (!rows[0]) return null;
  try {
    const value = JSON.parse(rows[0].value) as {
      clientId?: string;
      secret?: string;
      tenant?: string;
    };
    if (!value.clientId || !value.secret) return null;
    return {
      clientId: value.clientId,
      clientSecret: decrypt(value.secret),
      tenant: value.tenant || "common",
    };
  } catch {
    return null;
  }
}

/** Store an OAuth application; an empty secret keeps the stored one. */
export async function writeOAuthApp(
  sql: Sql,
  provider: "gmail" | "microsoft",
  input: { clientId: string; clientSecret: string; tenant: string },
): Promise<void> {
  if (!input.clientId.trim()) {
    await sql`delete from app_setting where key = ${appKey(provider)}`;
    return;
  }
  const current = await sql<{ value: string }>`
    select value from app_setting where key = ${appKey(provider)} limit 1
  `;
  let secret = "";
  if (input.clientSecret.trim()) secret = encrypt(input.clientSecret.trim());
  else if (current[0]) secret = (JSON.parse(current[0].value) as { secret?: string }).secret ?? "";
  const value = JSON.stringify({
    clientId: input.clientId.trim(),
    secret,
    tenant: input.tenant.trim() || "common",
  });
  await sql`
    insert into app_setting (key, value) values (${appKey(provider)}, ${value})
    on conflict (key) do update set value = excluded.value
  `;
}

export async function oauthConfigured(sql: Sql, provider: "gmail" | "microsoft"): Promise<boolean> {
  const rows = await sql<{ value: string }>`
    select value from app_setting where key = ${appKey(provider)} limit 1
  `;
  return Boolean(rows[0]);
}

/** What an account's sealed secret holds. */
export type AccountSecret =
  | { kind: "password"; password: string }
  | {
      kind: "oauth";
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scope: string;
    };

export function sealSecret(secret: AccountSecret): string {
  return encrypt(JSON.stringify(secret));
}

export function openSecret(sealed: string): AccountSecret | null {
  if (!sealed) return null;
  try {
    const value = JSON.parse(decrypt(sealed)) as AccountSecret;
    return value && (value.kind === "password" || value.kind === "oauth") ? value : null;
  } catch {
    return null;
  }
}

/** A host is trusted when an institutional profile or the administrator's list names it. */
export async function hostTrusted(sql: Sql, host: string, policy: MailPolicy): Promise<boolean> {
  const name = host.trim().toLowerCase();
  if (hostListed(name, policy.imapHosts)) return true;
  const profiles = await listProfiles(sql);
  return profiles.some((profile) => profile.host === name);
}

/**
 * Resolve an IMAP server and decide the address to connect to. The answer is used for the
 * connection itself (with the name kept for TLS), so a later DNS answer cannot change it.
 */
export async function resolveImapTarget(
  sql: Sql,
  host: string,
  port: number,
  policy: MailPolicy,
): Promise<TargetCheck> {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  const trusted = await hostTrusted(sql, name, policy);
  if (!trusted && policy.profilesOnly)
    return {
      ok: false,
      error: "Solo se pueden usar los servidores que el administrador configuró.",
    };
  if (!trusted && policy.imapHosts.length > 0)
    return { ok: false, error: "Ese servidor no está entre los autorizados." };
  let addresses: string[] = [];
  try {
    addresses = (await lookup(name, { all: true, verbatim: true })).map((item) => item.address);
  } catch {
    return { ok: false, error: "No se encontró ese servidor." };
  }
  return checkTarget({ host: name, port, addresses, trusted });
}
