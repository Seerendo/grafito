import { createHash } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import { getAuth } from "./server";

/** Server-side session resolution. Never trust client-supplied user IDs; use only the verified result. */

/**
 * requireUserId throws this with status 401 when no valid session exists. Keep the Unauthorized
 * message stable because clients compare it.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export type VerifiedUser = { id: string; email: string | null };

/**
 * Current request user or null. authMiddleware supplies bearerToken when authenticating without
 * a cookie.
 */
export async function getSessionUser(bearerToken?: string): Promise<VerifiedUser | null> {
  const request = getRequest();
  if (!request) return null;
  let headers = request.headers;
  if (bearerToken) {
    headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  return sessionUser(headers);
}

/**
 * Briefly cache verified sessions by exact signed cookie or bearer credential to reduce
 * authentication CPU. Sign-out invalidation may take the cache interval; revokeUser cuts access
 * immediately through assertLease on every request.
 */
const SESSION_CACHE_MS = 10_000;
const MAX_SESSIONS = 10_000;
const recentSessions = new Map<string, { user: VerifiedUser; until: number }>();

function credentialKey(headers: Headers): string | null {
  const authorization = headers.get("authorization") ?? "";
  const cookies = (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("session_token="))
    .sort()
    .join(";");
  if (!authorization && !cookies) return null;
  return createHash("sha256").update(`${authorization}\n${cookies}`).digest("base64url");
}

/** Resolve a user from these request headers, or null. */
export async function sessionUser(headers: Headers): Promise<VerifiedUser | null> {
  const key = credentialKey(headers);
  if (!key) return null;
  const now = Date.now();
  const known = recentSessions.get(key);
  if (known && known.until > now) return known.user;
  const session = await (await getAuth()).api.getSession({ headers });
  if (!session?.user) {
    recentSessions.delete(key);
    return null;
  }
  const user = { id: session.user.id, email: session.user.email ?? null };
  const expires = new Date(session.session.expiresAt).getTime();
  recentSessions.set(key, {
    user,
    until: Math.min(now + SESSION_CACHE_MS, Number.isFinite(expires) ? expires : now),
  });
  if (recentSessions.size > MAX_SESSIONS) {
    for (const [stale, entry] of recentSessions)
      if (entry.until <= now) recentSessions.delete(stale);
    while (recentSessions.size > MAX_SESSIONS)
      recentSessions.delete(recentSessions.keys().next().value!);
  }
  return user;
}

/** Verified user ID or UnauthorizedError; normally accessed through authMiddleware. */
export async function requireUserId(bearerToken?: string): Promise<string> {
  const user = await getSessionUser(bearerToken);
  if (!user) throw new UnauthorizedError();
  return user.id;
}
