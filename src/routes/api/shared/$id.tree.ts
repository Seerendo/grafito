import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { allows } from "@/server/profile";
import { apiCaller, apiError, failure } from "@/server/api";
import { sharedTreeForUser } from "@/server/share";
import { treeHttpResponse } from "@/server/tree-response";

/**
 * `GET /api/shared/:id/tree`: el árbol de algo compartido conmigo (o de un
 * espacio de trabajo), empaquetado (ver `domain/share-pack.ts`). Con ETag: si
 * no cambió desde la última vez, el navegador recibe un 304 sin cuerpo. Va
 * comprimido una sola vez por versión (no en cada petición). Con `?fresh=1`,
 * al día aunque haya uno guardado de hace unos segundos.
 */
export const Route = createFileRoute("/api/shared/$id/tree")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const caller = await apiCaller(request);
          const tree = await sharedTreeForUser(
            caller.sql,
            caller.userId,
            params.id,
            allows(caller.profile, PERMISSION.filesDownload),
            new URL(request.url).searchParams.get("fresh") === "1",
          );
          if (!tree) return apiError(404, "Ya no está compartido contigo.");
          return treeHttpResponse(request, tree);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
