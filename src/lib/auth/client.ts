import { genericOAuthClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { getBearerToken, setBearerToken } from "./bearer";
import { writeSessionUser } from "./session-sync";

/**
 * Cliente de Better Auth para el navegador. Habla con `/api/auth/*` del mismo
 * origen y, si hay un token bearer guardado, lo adjunta (ver `./bearer`).
 *
 * Para salir usa `signOut()` de aquí, no `authClient.signOut()`: la llamada
 * directa deja el token guardado y `onRequest` lo seguiría mandando.
 */
export const authClient = createAuthClient({
  // `signIn.oauth2` para el SSO por OpenID Connect.
  plugins: [genericOAuthClient()],
  fetchOptions: {
    onRequest(ctx) {
      const token = getBearerToken();
      if (token) ctx.headers.set("Authorization", `Bearer ${token}`);
      return ctx;
    },
  },
});

/**
 * Solo el servidor puede borrar la cookie HttpOnly, así que la salida espera su
 * respuesta (con un límite, para que el botón no quede colgado) y falla si no
 * llega: redirigir igual mostraría una salida que no ocurrió.
 */
const SIGN_OUT_TIMEOUT_MS = 10_000;

/** Cierra la sesión en el servidor, borra el token local y redirige. */
export async function signOut(redirectTo = "/"): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SIGN_OUT_TIMEOUT_MS);
  });
  const request = authClient
    .signOut()
    .then(({ error }) => (error ? "failed" : "ok"))
    .catch(() => "failed" as const);
  const outcome = await Promise.race([request, timeout]);
  clearTimeout(timer);

  if (outcome !== "ok") {
    throw new Error(
      outcome === "timeout"
        ? "Sign-out timed out — you are still signed in. Please try again."
        : "Sign-out failed — you are still signed in. Please try again.",
    );
  }
  setBearerToken(null);
  // Las demás pestañas también salen (ver `session-sync.ts`).
  writeSessionUser("");
  window.location.replace(redirectTo);
}
