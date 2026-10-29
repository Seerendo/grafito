import { createFileRoute } from "@tanstack/react-router";
import { apiError, failure } from "@/server/api";
import { publicTreeFor } from "@/server/share";
import { treeHttpResponse } from "@/server/tree-response";

/**
 * `GET /api/public/:token/tree`: lo publicado por enlace, sin sesión. Igual que
 * `/api/shared/:id/tree` (empaquetado, con ETag y comprimido una vez).
 */
export const Route = createFileRoute("/api/public/$token/tree")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          if (params.token.length < 16 || params.token.length > 64) return apiError(404, "Este enlace no existe o se retiró.");
          const { getSql } = await import("@/lib/db");
          const tree = await publicTreeFor(await getSql(), params.token, new URL(request.url).searchParams.get("fresh") === "1");
          if (!tree) return apiError(404, "Este enlace no existe o se retiró.");
          return treeHttpResponse(request, tree);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
