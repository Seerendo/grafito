import { createFileRoute } from "@tanstack/react-router";
import { apiCaller, failure, json } from "@/server/api";

/** GET /api/v1/me returns caller identity and permissions. */
export const Route = createFileRoute("/api/v1/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { userId, profile, via } = await apiCaller(request);
          return json({
            id: userId,
            name: profile.displayName,
            login: profile.loginName,
            role: profile.roleName,
            permissions: profile.permissions,
            auth: via,
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
