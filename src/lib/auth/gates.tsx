import { Navigate } from "@tanstack/react-router";

/** Ruta de ingreso. */
export const SIGN_IN_PATH = "/login";

/**
 * Redirección en cliente al ingreso (`<Navigate>`, sin recargar la SPA).
 * Renderízalo solo cuando `useCurrentUserState().isPending` ya sea falso.
 */
export function RedirectToSignIn({ to = SIGN_IN_PATH }: { to?: string }) {
  return <Navigate to={to} />;
}
