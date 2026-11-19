import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth/server";
import { foreignRedirects, redirectRefused } from "@/lib/auth/redirect-guard";
import { isPublicSignUp, signUpRefused } from "@/lib/auth/signup-guard";

/**
 * Better Auth over HTTP, without public sign-up (see signup-guard.ts) and with redirects only to
 * paths on this site (see redirect-guard.ts).
 */
async function handle(incoming: Request): Promise<Response> {
  // Identity providers set up before Better Auth 1.7 return to /oauth2/callback/sso; the same
  // callback now lives at /callback/sso.
  const request = incoming.url.includes("/api/auth/oauth2/callback/")
    ? new Request(
        incoming.url.replace("/api/auth/oauth2/callback/", "/api/auth/callback/"),
        incoming,
      )
    : incoming;
  const url = new URL(request.url);
  if (isPublicSignUp(url.pathname)) return signUpRefused();
  let body: unknown = null;
  if (request.method === "POST" && request.headers.get("content-type")?.includes("json"))
    body = await request
      .clone()
      .json()
      .catch(() => null);
  if (foreignRedirects(url.searchParams, body).length > 0) return redirectRefused();
  return (await getAuth()).handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
