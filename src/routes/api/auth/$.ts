import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth/server";
import { isPublicSignUp, signUpRefused } from "@/lib/auth/signup-guard";

/** Better Auth over HTTP, without public sign-up (see signup-guard.ts). */
async function handle(request: Request): Promise<Response> {
  if (isPublicSignUp(new URL(request.url).pathname)) return signUpRefused();
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
