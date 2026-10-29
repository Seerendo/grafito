import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { allows } from "@/server/profile";
import { apiCaller, apiError, failure } from "@/server/api";
import { sharedTreeForUser } from "@/server/share";

/**
 * `GET /api/shared/:id/tree`: el árbol de algo compartido conmigo (o de un
 * espacio de trabajo), empaquetado (ver `domain/share-pack.ts`). Con ETag: si
 * no cambió desde la última vez, el navegador recibe un 304 sin cuerpo. Va
 * comprimido una sola vez por versión (no en cada petición). Lo de cada
 * persona (su nivel de acceso) viaja en la cabecera `x-grafito-share`. Con
 * `?fresh=1`, al día aunque haya uno guardado de hace unos segundos.
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
          const headers: Record<string, string> = {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "private, no-cache",
            etag: tree.etag,
            vary: "Accept-Encoding, Authorization, Cookie",
            "x-grafito-share": encodeURIComponent(JSON.stringify(tree.share)),
            "x-content-type-options": "nosniff",
          };
          if (request.headers.get("if-none-match") === tree.etag) return new Response(null, { status: 304, headers });
          if (/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) {
            return new Response(new Uint8Array(tree.gzip()), { headers: { ...headers, "content-encoding": "gzip" } });
          }
          return new Response(tree.body, { headers });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
