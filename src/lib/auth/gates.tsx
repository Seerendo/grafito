import { Navigate } from "@tanstack/react-router";

/** Sign-in route. */
export const SIGN_IN_PATH = "/login";

/**
 * Client-side Navigate redirect to sign-in without reloading the SPA. Render only after
 * user-state loading finishes.
 */
export function RedirectToSignIn({ to = SIGN_IN_PATH }: { to?: string }) {
  return <Navigate to={to} />;
}
