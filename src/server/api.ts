import type { Sql } from "@/lib/db";
import { assertLease } from "@/server/lease";
import { readUserProfile, type UserProfile } from "@/server/profile";
import { resolveToken, TOKEN_PREFIX } from "@/server/api-tokens";
import { VaultError } from "@/server/vault";

/**
 * Utilidades de las rutas HTTP propias (`/api/v1/*`, `/api/ai/*`), solo servidor.
 *
 * Autenticación, en este orden:
 *  - `Authorization: Bearer gft_…`: token personal (Cuenta → API).
 *  - La sesión del navegador (cookie o bearer de sesión), con su plazo vigente.
 *    Con cookie, solo desde el mismo sitio: otra web no puede usarla a escondidas.
 */

export type ApiCaller = { sql: Sql; userId: string; profile: UserProfile; via: "token" | "session" };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function apiError(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** Convierte errores conocidos en respuestas HTTP. */
export function failure(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof VaultError) return apiError(error.status, error.message);
  console.error("[api]", error);
  return apiError(500, "Error interno.");
}

function sameSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

/** Quién llama, o lanza una `Response` 401/403 lista para devolver. */
export async function apiCaller(request: Request): Promise<ApiCaller> {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (bearer.startsWith(TOKEN_PREFIX)) {
    const userId = await resolveToken(sql, bearer);
    if (!userId) throw apiError(401, "Token no válido.");
    return { sql, userId, profile: await readUserProfile(sql, userId), via: "token" };
  }
  if (!bearer && !sameSite(request)) throw apiError(403, "Petición de otro sitio.");
  const { getAuth } = await import("@/lib/auth/server");
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!session?.user) throw apiError(401, "Inicia sesión o usa un token personal.");
  const lease = await assertLease(sql, session.user.id);
  if (!lease.ok) throw apiError(401, "La sesión venció.");
  return { sql, userId: session.user.id, profile: await readUserProfile(sql, session.user.id), via: "session" };
}

export function requirePermission(profile: UserProfile, key: string, message: string): void {
  if (!profile.isAdmin && !profile.permissions.includes(key)) throw apiError(403, message);
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw apiError(400, "El cuerpo debe ser JSON.");
  }
}
