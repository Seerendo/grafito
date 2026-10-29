import { createHash } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import { getAuth } from "./server";

/**
 * Resolución de la sesión en el servidor (solo servidor). Nunca fiarse de un id
 * de usuario mandado por el cliente: solo del resultado de esta verificación.
 */

/**
 * Lo lanza `requireUserId` sin sesión válida. Lleva `status: 401`; el mensaje
 * es un contrato estable: el cliente compara `err.message === "Unauthorized"`.
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
 * Usuario de la petición actual, o `null` sin sesión. `bearerToken` llega de
 * `authMiddleware` cuando el cliente se autentica con el token en vez de la
 * cookie (ver `./bearer`).
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
 * Sesiones verificadas hace poco, por credencial (la cookie de sesión firmada
 * o el token bearer, tal cual llegan): validar con Better Auth en cada
 * petición era lo que más CPU gastaba con mucha gente. Se guarda unos
 * segundos; cerrar sesión deja de valer como mucho en ese tiempo, y quitar el
 * acceso a alguien (`revokeUser`) corta al momento por el plazo de
 * `assertLease`, que se mira en cada petición.
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

/** El usuario de la sesión que traen estas cabeceras, o `null`. */
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
  recentSessions.set(key, { user, until: Math.min(now + SESSION_CACHE_MS, Number.isFinite(expires) ? expires : now) });
  if (recentSessions.size > MAX_SESSIONS) {
    for (const [stale, entry] of recentSessions) if (entry.until <= now) recentSessions.delete(stale);
    while (recentSessions.size > MAX_SESSIONS) recentSessions.delete(recentSessions.keys().next().value!);
  }
  return user;
}

/** Id del usuario verificado, o `UnauthorizedError`. Mejor vía `authMiddleware`. */
export async function requireUserId(bearerToken?: string): Promise<string> {
  const user = await getSessionUser(bearerToken);
  if (!user) throw new UnauthorizedError();
  return user.id;
}
