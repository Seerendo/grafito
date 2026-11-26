import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import { readOAuthApp, type AccountSecret } from "./settings";
import { MailError, retryAfterMs } from "./providers/types";

/**
 * OAuth 2.0 for Gmail and Microsoft 365 / Outlook.com: authorization code with PKCE (S256) and a
 * single-use state bound to the person, read-only scopes, and refresh tokens renewed on the
 * server. The application's client secret is an administrator setting and never reaches the
 * browser; the person's tokens are sealed in their account row.
 */

export type OAuthProvider = "gmail" | "microsoft";

const SCOPES: Record<OAuthProvider, string> = {
  gmail:
    "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
  microsoft:
    "openid email offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
};

const STATE_MS = 10 * 60 * 1000;

function endpoints(provider: OAuthProvider, tenant: string) {
  if (provider === "gmail")
    return {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
    };
  const t = encodeURIComponent(tenant || "common");
  return {
    authorize: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
  };
}

/** Where the provider sends the person back: this installation's public origin. */
export function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/mail/oauth/callback`;
}

/** The provider's sign-in page for this person, with a fresh state and PKCE verifier. */
export async function authorizeUrl(
  sql: Sql,
  input: {
    userId: string;
    provider: OAuthProvider;
    origin: string;
    accountId: string | null;
    hint: string;
  },
): Promise<string> {
  const app = readOAuthApp(input.provider);
  if (!app) throw new MailError("permanent", "Esa conexión no está configurada en el servidor.");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await sql`delete from mail_oauth_state where created_at < ${Date.now() - STATE_MS}`;
  await sql`
    insert into mail_oauth_state (state, user_id, provider, verifier, account_id, created_at)
    values (${state}, ${input.userId}, ${input.provider}, ${verifier}, ${input.accountId}, ${Date.now()})
  `;
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(input.origin),
    response_type: "code",
    scope: SCOPES[input.provider],
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (input.provider === "gmail") {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  } else params.set("prompt", "select_account");
  if (input.hint) params.set("login_hint", input.hint);
  return `${endpoints(input.provider, app.tenant).authorize}?${params}`;
}

/** Take a state once: it must exist, be recent and belong to this person. */
export async function takeState(
  sql: Sql,
  state: string,
  userId: string,
): Promise<{ provider: OAuthProvider; verifier: string; accountId: string | null } | null> {
  const rows = await sql<{
    provider: string;
    verifier: string;
    account_id: string | null;
    user_id: string;
    created_at: unknown;
  }>`delete from mail_oauth_state where state = ${state} returning provider, verifier, account_id, user_id, created_at`;
  const row = rows[0];
  if (!row || row.user_id !== userId || Number(row.created_at) < Date.now() - STATE_MS) return null;
  if (row.provider !== "gmail" && row.provider !== "microsoft") return null;
  return { provider: row.provider, verifier: row.verifier, accountId: row.account_id };
}

type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  sql: Sql,
  provider: OAuthProvider,
  body: Record<string, string>,
): Promise<TokenAnswer> {
  const app = readOAuthApp(provider);
  if (!app) throw new MailError("permanent", "Esa conexión no está configurada en el servidor.");
  let response: Response;
  try {
    response = await fetch(endpoints(provider, app.tenant).token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        ...body,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MailError("connection", "No se pudo contactar con el proveedor.");
  }
  if (response.status === 429)
    throw new MailError(
      "rate_limited",
      "El proveedor pidió esperar.",
      retryAfterMs(response.headers.get("retry-after")),
    );
  const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
  if (!response.ok || answer.error) {
    if (answer.error === "invalid_grant")
      throw new MailError(
        "expired",
        "La autorización caducó o se revocó. Vuelve a conectar la cuenta.",
      );
    if (response.status >= 500) throw new MailError("temporary", "El proveedor no respondió bien.");
    throw new MailError("auth", "El proveedor rechazó la autorización.");
  }
  return answer;
}

/** The email in an ID token, read without trusting it for anything else. */
function emailOf(idToken: string | undefined): string {
  const body = idToken?.split(".")[1];
  if (!body) return "";
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
    };
    return (claims.email ?? claims.preferred_username ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

export async function exchangeCode(
  sql: Sql,
  input: { provider: OAuthProvider; code: string; verifier: string; origin: string },
): Promise<{ secret: Extract<AccountSecret, { kind: "oauth" }>; email: string }> {
  const answer = await tokenRequest(sql, input.provider, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: redirectUri(input.origin),
  });
  if (!answer.access_token || !answer.refresh_token)
    throw new MailError("auth", "El proveedor no devolvió una autorización duradera.");
  return {
    email: emailOf(answer.id_token),
    secret: {
      kind: "oauth",
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token,
      expiresAt: Date.now() + Number(answer.expires_in ?? 3600) * 1000,
      scope: answer.scope ?? SCOPES[input.provider],
    },
  };
}

/** A valid access token, renewed when it ends within a minute. */
export async function freshToken(
  sql: Sql,
  provider: OAuthProvider,
  secret: Extract<AccountSecret, { kind: "oauth" }>,
  save: (next: Extract<AccountSecret, { kind: "oauth" }>) => Promise<void>,
): Promise<string> {
  if (secret.expiresAt > Date.now() + 60_000) return secret.accessToken;
  const answer = await tokenRequest(sql, provider, {
    grant_type: "refresh_token",
    refresh_token: secret.refreshToken,
  });
  if (!answer.access_token) throw new MailError("expired", "No se pudo renovar la autorización.");
  const next = {
    kind: "oauth" as const,
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token || secret.refreshToken,
    expiresAt: Date.now() + Number(answer.expires_in ?? 3600) * 1000,
    scope: answer.scope ?? secret.scope,
  };
  await save(next);
  Object.assign(secret, next);
  return next.accessToken;
}

/** A JSON request to a provider API with the usual failure classification. */
export async function providerJson<T>(
  url: string,
  token: string,
  init: { headers?: Record<string, string> } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new MailError("connection", "No se pudo contactar con el proveedor.");
  }
  if (response.ok) return (await response.json()) as T;
  const retry = retryAfterMs(response.headers.get("retry-after"));
  if (response.status === 429 || response.status === 503)
    throw new MailError("rate_limited", "El proveedor pidió esperar.", retry);
  if (response.status === 401) throw new MailError("expired", "La autorización ya no es válida.");
  if (response.status === 403)
    throw new MailError("auth", "El proveedor no permite leer este buzón.");
  if (response.status === 404 || response.status === 410)
    throw new MailError("cursor", "El proveedor ya no reconoce el punto de sincronización.");
  throw new MailError("temporary", `El proveedor respondió ${response.status}.`);
}

/** POST to a provider to send mail. A 403 means the account was authorized before sending existed. */
export async function providerSend(
  url: string,
  token: string,
  body: string,
  contentType: string,
  method: "POST" | "PATCH" = "POST",
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new MailError("connection", "No se pudo contactar con el proveedor.");
  }
  if (response.ok) return;
  const retry = retryAfterMs(response.headers.get("retry-after"));
  if (response.status === 429 || response.status === 503)
    throw new MailError("rate_limited", "El proveedor pidió esperar.", retry);
  if (response.status === 401) throw new MailError("expired", "La autorización ya no es válida.");
  if (response.status === 403)
    throw new MailError(
      "permanent",
      "La cuenta no tiene permiso para enviar: vuelve a autorizarla.",
    );
  if (response.status === 400 || response.status === 413)
    throw new MailError("permanent", "El proveedor rechazó el mensaje (¿adjuntos muy grandes?).");
  throw new MailError("temporary", `El proveedor respondió ${response.status}.`);
}
