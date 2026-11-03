/**
 * Session bearer token in localStorage shared across tabs; see session-sync.ts. Better Auth
 * returns set-auth-token on sign-in/password changes. It preserves authentication when Secure
 * __Host- cookies are unavailable over non-localhost HTTP; otherwise it is redundant.
 */
const BEARER_KEY = "grafito-auth.bearer-token";

export function getBearerToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

export function setBearerToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(BEARER_KEY, token);
    else window.localStorage.removeItem(BEARER_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Store a Better Auth response token when present. */
export function rememberBearerFrom(response: Response): void {
  const token = response.headers.get("set-auth-token");
  if (token) setBearerToken(token);
}

/** Authorization header for manual fetch calls, or no header. */
export function bearerHeader(): Record<string, string> {
  const token = getBearerToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
