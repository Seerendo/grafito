/**
 * Token de sesión como bearer, guardado en `localStorage`: lo comparten todas
 * las pestañas del navegador, que así tienen una sola sesión (ver
 * `session-sync.ts`).
 *
 * Better Auth devuelve el token en la cabecera `set-auth-token` al entrar o al
 * cambiar la contraseña. Si el navegador no guarda la cookie `__Host-` (Secure
 * sobre http fuera de localhost, p. ej. un servidor sin HTTPS), el cliente
 * sigue autenticado mandando este token. Con la cookie funcionando, el token
 * es redundante e inofensivo.
 *
 * Antes vivía en `sessionStorage` (una sesión por pestaña); se migra al leerlo.
 * La clave conserva el nombre heredado para no perder sesiones abiertas.
 */
const BEARER_KEY = "grok-auth.bearer-token";

export function getBearerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const shared = window.localStorage.getItem(BEARER_KEY);
    if (shared) return shared;
    const legacy = window.sessionStorage.getItem(BEARER_KEY);
    if (legacy) {
      window.localStorage.setItem(BEARER_KEY, legacy);
      window.sessionStorage.removeItem(BEARER_KEY);
    }
    return legacy;
  } catch {
    return null;
  }
}

export function setBearerToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(BEARER_KEY, token);
    else window.localStorage.removeItem(BEARER_KEY);
    window.sessionStorage.removeItem(BEARER_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Guarda el token que trae una respuesta de Better Auth, si trae uno. */
export function rememberBearerFrom(response: Response): void {
  const token = response.headers.get("set-auth-token");
  if (token) setBearerToken(token);
}

/** Cabecera `Authorization` para un `fetch` a mano, o nada. */
export function bearerHeader(): Record<string, string> {
  const token = getBearerToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
