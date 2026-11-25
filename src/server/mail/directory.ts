import type { Sql } from "@/lib/db";
import { connectorAccount } from "./accounts";
import { MailError } from "./providers/types";
import { webRequest } from "./web";

/**
 * Recipients by name while writing: people the person already wrote to or heard from
 * (mail_contact), and the directory of the account's server when it has one. Zimbra answers name
 * searches of its global address list (GAL) through its SOAP interface with the account's own
 * password; the first try decides whether the server is a Zimbra (directory = zimbra or none).
 */

export type Suggestion = { name: string; address: string; source: "contactos" | "directorio" };

const LOCAL_LIMIT = 8;
const DIRECTORY_LIMIT = 10;

export async function suggestRecipients(
  sql: Sql,
  userId: string,
  query: string,
): Promise<Suggestion[]> {
  const term = query.trim().toLowerCase();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, "")}%`;
  const local = await sql<{ name: string; address: string }>`
    select name, address from mail_contact
    where user_id = ${userId} and (address like ${like} or lower(name) like ${like})
    order by (lower(name) like ${`${term}%`} or address like ${`${term}%`}) desc, uses desc, last_at desc
    limit ${LOCAL_LIMIT}
  `;
  const found = new Map<string, Suggestion>();
  for (const row of local)
    found.set(row.address, { name: row.name, address: row.address, source: "contactos" });
  const accounts = await sql<{ id: string }>`
    select id from mail_account
    where user_id = ${userId} and provider = 'imap' and secret <> '' and directory <> 'none'
    order by is_default desc, created_at
  `;
  const answers = await Promise.all(
    accounts.map((account) => zimbraSearch(sql, account.id, term).catch(() => [])),
  );
  for (const list of answers)
    for (const person of list)
      if (!found.has(person.address))
        found.set(person.address, { ...person, source: "directorio" });
  return [...found.values()].slice(0, LOCAL_LIMIT + DIRECTORY_LIMIT);
}

/** Zimbra sessions per account, so a search does not sign in on every keystroke. */
const tokens = new Map<string, { token: string; until: number }>();

type Soap = {
  Body?: Record<string, unknown> & {
    Fault?: { Reason?: { Text?: string }; Detail?: { Error?: { Code?: string } } };
  };
};

function soapUrl(account: { host: string; webHost: string }): string {
  return `https://${account.webHost || account.host}/service/soap`;
}

async function soap(url: string, body: unknown): Promise<{ status: number; json: Soap | null }> {
  const answer = await webRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 6_000,
  });
  let json: Soap | null = null;
  try {
    json = JSON.parse(answer.body) as Soap;
  } catch {
    json = null;
  }
  return { status: answer.status, json };
}

async function zimbraSearch(
  sql: Sql,
  accountId: string,
  term: string,
): Promise<{ name: string; address: string }[]> {
  const account = await connectorAccount(sql, accountId);
  if (!account || account.secret?.kind !== "password") return [];
  const rows = await sql<{ web_host: string }>`
    select web_host from mail_account where id = ${accountId} limit 1
  `;
  const url = soapUrl({ host: account.host, webHost: rows[0]?.web_host ?? "" });
  const notZimbra = async () => {
    await sql`update mail_account set directory = 'none' where id = ${accountId} and directory = 'auto'`;
    return [];
  };
  let session = tokens.get(accountId);
  if (!session || session.until < Date.now()) {
    let auth: { status: number; json: Soap | null };
    try {
      auth = await soap(url, {
        Header: { context: { _jsns: "urn:zimbra", format: { type: "js" } } },
        Body: {
          AuthRequest: {
            _jsns: "urn:zimbraAccount",
            account: { by: "name", _content: account.username || account.email },
            password: { _content: account.secret.password },
          },
        },
      });
    } catch (error) {
      // No HTTPS server at that address: not a Zimbra (a network failure is retried later).
      if (error instanceof MailError && /rechazó la conexión|certificado/.test(error.message))
        return notZimbra();
      return [];
    }
    const response = auth.json?.Body?.AuthResponse as
      { authToken?: { _content?: string }[]; lifetime?: number } | undefined;
    const token = response?.authToken?.[0]?._content;
    if (!token) {
      if (!auth.json?.Body?.Fault) return notZimbra();
      return [];
    }
    session = {
      token,
      until: Date.now() + Math.min(Number(response?.lifetime ?? 0) || 3_600_000, 3_600_000),
    };
    tokens.set(accountId, session);
    await sql`update mail_account set directory = 'zimbra' where id = ${accountId} and directory = 'auto'`;
  }
  const search = await soap(url, {
    Header: { context: { _jsns: "urn:zimbra", authToken: { _content: session.token } } },
    Body: {
      AutoCompleteGalRequest: {
        _jsns: "urn:zimbraAccount",
        name: term,
        type: "account",
        limit: DIRECTORY_LIMIT,
      },
    },
  });
  if (search.json?.Body?.Fault) {
    tokens.delete(accountId);
    return [];
  }
  const found = (
    search.json?.Body?.AutoCompleteGalResponse as {
      cn?: { _attrs?: Record<string, string> }[];
    }
  )?.cn;
  return (found ?? [])
    .map((item) => {
      const attrs = item._attrs ?? {};
      const name =
        attrs.fullName || [attrs.firstName, attrs.lastName].filter(Boolean).join(" ") || "";
      return { name: name.trim().slice(0, 200), address: (attrs.email ?? "").trim().toLowerCase() };
    })
    .filter((item) => item.address.includes("@"))
    .slice(0, DIRECTORY_LIMIT);
}

/** Forget a cached Zimbra session (new password, disconnected account). */
export function forgetDirectorySession(accountId: string): void {
  tokens.delete(accountId);
}
