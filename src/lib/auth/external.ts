import { authClient } from "./client";
import { rememberBearerFrom } from "./bearer";

/** Inicio de sesión por LDAP, OAuth o SSO desde el navegador. */

/** Entra con usuario y contraseña del directorio. */
export async function ldapSignIn(username: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch("/api/auth/ldap/sign-in", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return { ok: false, error: body?.message || "Usuario o contraseña incorrectos." };
  }
  rememberBearerFrom(response);
  authClient.$store.notify("$sessionSignal");
  return { ok: true };
}

/** Redirige al proveedor (Google, GitHub, Microsoft o el SSO configurado). */
export async function signInWithProvider(provider: "google" | "github" | "microsoft" | "sso"): Promise<string | null> {
  const urls = { callbackURL: "/", errorCallbackURL: "/login" };
  const { error } =
    provider === "sso"
      ? await authClient.signIn.oauth2({ providerId: "sso", ...urls })
      : await authClient.signIn.social({ provider, ...urls });
  return error ? error.message || "No se pudo iniciar sesión con ese proveedor." : null;
}

/** Texto para el `?error=` con el que Better Auth vuelve al ingreso. */
export function providerErrorMessage(code: string): string {
  if (code.includes("unable_to_create_user")) return "Tu cuenta no tiene acceso a Grafito (dominio no permitido).";
  if (code.includes("access_denied")) return "Cancelaste el inicio de sesión.";
  if (code.includes("account_not_linked")) return "Ya existe otra cuenta con ese correo.";
  return "No se pudo iniciar sesión con ese proveedor.";
}
