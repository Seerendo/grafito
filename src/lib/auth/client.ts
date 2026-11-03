import { genericOAuthClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { getBearerToken, setBearerToken } from "./bearer";
import { writeSessionUser } from "./session-sync";

/**
 * Browser Better Auth client uses same-origin /api/auth and attaches a saved bearer token. Use
 * this module's signOut wrapper so local tokens are cleared; calling authClient.signOut
 * directly would keep sending them.
 */
export const authClient = createAuthClient({
  // signIn.oauth2 implements OIDC SSO.
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
 * Only the server can clear HttpOnly cookies. Wait for sign-out confirmation with a timeout,
 * and report failure rather than falsely showing a signed-out state.
 */
const SIGN_OUT_TIMEOUT_MS = 10_000;

/** Close the server session, clear the local token and redirect. */
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
  // Sign out other tabs too; see session-sync.ts.
  writeSessionUser("");
  window.location.replace(redirectTo);
}
