import { useMemo } from "react";
import { authClient } from "./client";

/** Forma normalizada del usuario que usa toda la app. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
};

export type CurrentUserState = {
  /** `null` tanto mientras carga la sesión como sin sesión. */
  user: AppUser | null;
  /** Verdadero mientras la sesión se resuelve: `user: null` aún no es "fuera". */
  isPending: boolean;
};

/**
 * Usuario actual y estado de carga, desde `useSession()` de Better Auth.
 *
 * Para proteger una pantalla, espera a que `isPending` sea falso antes de
 * redirigir; si no, cada recarga manda al ingreso a quien sí tenía sesión.
 */
export function useCurrentUserState(): CurrentUserState {
  const { data, isPending } = authClient.useSession();
  const id = data?.user.id;
  const displayName = data?.user.name ?? null;
  const primaryEmail = data?.user.email ?? null;
  const profileImageUrl = data?.user.image ?? null;
  const user = useMemo<AppUser | null>(
    () => (id ? { id, displayName, primaryEmail, profileImageUrl } : null),
    [id, displayName, primaryEmail, profileImageUrl],
  );
  return useMemo(() => ({ user, isPending }), [user, isPending]);
}

/** `useCurrentUserState().user`; `null` significa "cargando o sin sesión". */
export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
