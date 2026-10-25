import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, requirePermission } from "@/server/api";
import { fileBytes, getDoc } from "@/server/vault";

/** `GET /api/v1/notes/:id/file`: descarga el archivo. */
export const Route = createFileRoute("/api/v1/notes/$id/file")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.filesDownload, "Tu rol no puede descargar archivos.");
          const doc = await getDoc(sql, userId, params.id);
          const file = doc ? fileBytes(doc) : null;
          if (!doc?.file || !file) return apiError(404, "Ese archivo no existe.");
          const name = encodeURIComponent(doc.file.name);
          return new Response(new Uint8Array(file.bytes), {
            headers: {
              "content-type": file.mime,
              "content-disposition": `attachment; filename*=UTF-8''${name}`,
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
