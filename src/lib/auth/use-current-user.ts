import { useMemo } from "react";
import { authClient } from "./client";

/** Normalized user shape used throughout the application. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: string | null;
};

export type CurrentUserState = {
  /** null while loading or when signed out. */
  user: AppUser | null;
  /** Session resolution is pending; a null user does not yet mean signed out. */
  isPending: boolean;
};

/**
 * Current Better Auth user and loading state. Protected screens must wait until isPending=false
 * before redirecting, avoiding false sign-in redirects on reload.
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

/** Current user shortcut; null means loading or signed out. */
export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
