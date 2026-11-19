/**
 * Where Better Auth sends the browser after signing in, a provider callback, a reset or a
 * verification. Grafito only ever asks for paths on its own address ("/", "/login"), so an
 * absolute or protocol-relative address in those fields is refused before Better Auth stores
 * it: with a forged Host or X-Forwarded-Host it would otherwise be trusted and become an open
 * redirect after the provider's callback (security finding GRAF-13).
 */

const FIELDS = ["callbackURL", "errorCallbackURL", "newUserCallbackURL", "redirectTo"] as const;

/** A path on this site: starts with one slash, no scheme, no backslash, no control characters. */
export function isLocalPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    ![...value].some((char) => char.charCodeAt(0) < 32)
  );
}

/** The redirect fields of a query and of a JSON body that are not local paths. */
export function foreignRedirects(query: URLSearchParams, body: unknown): string[] {
  const out: string[] = [];
  for (const field of FIELDS) {
    const value = query.get(field);
    if (value !== null && !isLocalPath(value)) out.push(field);
  }
  if (body && typeof body === "object") {
    for (const field of FIELDS) {
      const value = (body as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !isLocalPath(value)) out.push(field);
    }
  }
  return [...new Set(out)];
}

/** The refusal, in Better Auth's error shape. */
export function redirectRefused(): Response {
  return Response.json(
    { code: "INVALID_CALLBACK_URL", message: "Only paths on this site are accepted" },
    { status: 400 },
  );
}
