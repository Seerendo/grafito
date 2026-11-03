import { authClient } from "./client";
import { bearerHeader, rememberBearerFrom } from "./bearer";

/** Shared username/password calls to /api/auth for sign-in and account screens. */

/**
 * Notify useSession after direct fetch requests. Better Auth automatically signals changes only
 * through authClient; direct calls are needed to read set-auth-token.
 */
function refreshSessionStore(): void {
  authClient.$store.notify("$sessionSignal");
}

/** Sign in with email/password and refresh session state; return whether accepted. */
export async function signInWithPassword(email: string, password: string): Promise<boolean> {
  return (await signInDetailed(email, password)).ok;
}

/**
 * Password sign-in with server-provided rejection details such as TEMP_ACCESS_EXPIRED; see
 * server/temp-access.ts.
 */
export async function signInDetailed(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const response = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.ok) {
    rememberBearerFrom(response);
    refreshSessionStore();
    return { ok: true };
  }
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return { ok: false, code: body?.message ?? "" };
}

/** Change the current session's password and report acceptance. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
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
