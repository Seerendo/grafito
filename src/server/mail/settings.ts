import { lookup } from "node:dns/promises";
import type { Sql } from "@/lib/db";
import { checkTarget, hostListed, type TargetCheck } from "@/domain/mail/hosts";
import { parseMailPolicy, type MailPolicy } from "@/domain/mail/policy";
import { decrypt, encrypt } from "@/server/crypto";

/**
 * Email module settings shared by the web app and the mail-sync worker: the limits, the OAuth
 * applications and trusted hosts of the server's environment, account secrets and where an IMAP
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

/** OAuth application of a provider, from the server's environment. The secret never leaves it. */
export type OAuthApp = { clientId: string; clientSecret: string; tenant: string };

export function readOAuthApp(provider: "gmail" | "microsoft"): OAuthApp | null {
  const prefix = provider === "gmail" ? "MAIL_GMAIL" : "MAIL_MICROSOFT";
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim() ?? "";
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, tenant: process.env.MAIL_MICROSOFT_TENANT?.trim() || "common" };
}

export function oauthConfigured(provider: "gmail" | "microsoft"): boolean {
  return readOAuthApp(provider) !== null;
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

/**
 * IMAP hosts on a private network that people may use (MAIL_TRUSTED_HOSTS: exact names or
 * *.suffix, comma separated). Any other host must resolve to public addresses.
 */
function hostTrusted(host: string): boolean {
  const listed = (process.env.MAIL_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return hostListed(host, listed);
}

/**
 * Resolve an IMAP server and decide the address to connect to. The answer is used for the
 * connection itself (with the name kept for TLS), so a later DNS answer cannot change it.
 */
export async function resolveImapTarget(host: string, port: number): Promise<TargetCheck> {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  const trusted = hostTrusted(name);
  let addresses: string[] = [];
  try {
    addresses = (await lookup(name, { all: true, verbatim: true })).map((item) => item.address);
  } catch {
    return { ok: false, error: "No se encontró ese servidor." };
  }
  return checkTarget({ host: name, port, addresses, trusted });
}
