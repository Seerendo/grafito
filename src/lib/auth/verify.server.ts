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
  const session = await (await getAuth()).api.getSession({ headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

/** Id del usuario verificado, o `UnauthorizedError`. Mejor vía `authMiddleware`. */
export async function requireUserId(bearerToken?: string): Promise<string> {
  const user = await getSessionUser(bearerToken);
  if (!user) throw new UnauthorizedError();
  return user.id;
}
