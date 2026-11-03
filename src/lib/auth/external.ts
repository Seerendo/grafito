import { authClient } from "./client";
import { rememberBearerFrom } from "./bearer";
import { t } from "@/app/i18n";

/** Browser LDAP, OAuth and SSO sign-in. */

/** Sign in with directory username and password. */
export async function ldapSignIn(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await fetch("/api/auth/ldap/sign-in", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return { ok: false, error: body?.message || t("Usuario o contraseña incorrectos.") };
  }
  rememberBearerFrom(response);
  authClient.$store.notify(t("$sessionSignal"));
  return { ok: true };
}

/** Redirect to Google, GitHub, Microsoft or configured SSO. */
export async function signInWithProvider(
  provider: "google" | "github" | "microsoft" | "sso",
): Promise<string | null> {
  const urls = { callbackURL: "/", errorCallbackURL: "/login" };
  const { error } =
    provider === "sso"
      ? await authClient.signIn.oauth2({ providerId: "sso", ...urls })
      : await authClient.signIn.social({ provider, ...urls });
  return error ? error.message || t("No se pudo iniciar sesión con ese proveedor.") : null;
}

/** Display text for Better Auth's ?error= redirect. */
export function providerErrorMessage(code: string): string {
  if (code.includes("unable_to_create_user"))
    return t("Tu cuenta no tiene acceso a Grafito (dominio no permitido).");
  if (code.includes("access_denied")) return t("Cancelaste el inicio de sesión.");
  if (code.includes("account_not_linked")) return t("Ya existe otra cuenta con ese correo.");
  return t("No se pudo iniciar sesión con ese proveedor.");
}
