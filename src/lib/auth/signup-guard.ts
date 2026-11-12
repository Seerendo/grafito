/**
 * Accounts are created only by Grafito itself: the initial administrator, administrators
 * creating users, and LDAP/SSO provisioning. Those call Better Auth on the server
 * (auth.api.signUpEmail, the internal adapter), never over HTTP, so the public email sign-up
 * endpoint is refused before it reaches Better Auth. Leaving it open let anyone create a session
 * and claim a username (or the administrator's) before it was created on purpose.
 */

/** Whether this request path is Better Auth's email sign-up endpoint, however it is spelled. */
export function isPublicSignUp(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is checked as written.
  }
  const normal = path
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  return normal.endsWith("/sign-up/email");
}

/** The refusal, in Better Auth's error shape. */
export function signUpRefused(): Response {
  return Response.json(
    { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED", message: "Sign up is not enabled" },
    { status: 403 },
  );
}
