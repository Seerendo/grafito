import { authClient } from "./client";
import { bearerHeader, rememberBearerFrom } from "./bearer";

/**
 * Llamadas de usuario y contraseña contra `/api/auth/*`, compartidas por el
 * ingreso (`AccessGate`) y la cuenta (`AccountScreen`).
 */

/**
 * Avisa a `useSession()` de que la sesión cambió. Better Auth solo lo hace solo
 * cuando la llamada pasa por `authClient`; aquí usamos `fetch` directo (para
 * leer `set-auth-token`), así que hay que dar la señal a mano.
 */
function refreshSessionStore(): void {
  authClient.$store.notify("$sessionSignal");
}

/** Entra con email y contraseña y refresca la sesión. Devuelve si se aceptó. */
export async function signInWithPassword(email: string, password: string): Promise<boolean> {
  const response = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.ok) {
    rememberBearerFrom(response);
    refreshSessionStore();
  }
  return response.ok;
}

/** Cambia la contraseña de la sesión actual. Devuelve si se aceptó. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
  const response = await fetch("/api/auth/change-password", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...bearerHeader() },
    body: JSON.stringify({ currentPassword, newPassword, revokeOtherSessions: false }),
  });
  if (response.ok) {
    rememberBearerFrom(response);
    refreshSessionStore();
  }
  return response.ok;
}
