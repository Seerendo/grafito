import { useEffect } from "react";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { onSessionUserChange, writeSessionUser } from "@/lib/auth/session-sync";

/**
 * Synchronize browser-tab sessions through lib/auth/session-sync.ts, publishing local sign-ins
 * and following other tabs.
 */
export function SessionSync() {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id ?? "";

  // Current tab's session owner, regardless of sign-in method.
  useEffect(() => {
    if (isPending || !userId) return;
    writeSessionUser(userId);
  }, [isPending, userId]);

  useEffect(
    () =>
      onSessionUserChange((next) => {
        if (next === userId) return;
        // Another tab signed out: show sign-in. A different user signed in: reload with that session.
        if (!next) window.location.replace("/");
        else window.location.reload();
      }),
    [userId],
  );

  return null;
}
