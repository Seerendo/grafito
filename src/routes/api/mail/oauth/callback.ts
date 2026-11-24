import { createFileRoute } from "@tanstack/react-router";

/**
 * GET /api/mail/oauth/callback: where Google or Microsoft send the person back. Nothing is
 * exchanged here: the code and state go to /correo, where the signed-in session finishes the
 * sign-in and the state must belong to that same person (mailOAuthFinish).
 */
export const Route = createFileRoute("/api/mail/oauth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const params = new URLSearchParams();
        for (const key of ["code", "state", "error"]) {
          const value = url.searchParams.get(key);
          if (value) params.set(`oauth_${key}`, value.slice(0, 4000));
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: `/correo?${params}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      },
    },
  },
});
