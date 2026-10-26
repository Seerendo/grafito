import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, requirePermission } from "@/server/api";
import { fileResponse } from "@/server/files";
import { getDoc } from "@/server/vault";

/** `GET /api/v1/notes/:id/file`: descarga el archivo. */
export const Route = createFileRoute("/api/v1/notes/$id/file")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.filesDownload, "Tu rol no puede descargar archivos.");
          const doc = await getDoc(sql, userId, params.id);
          const response = doc?.file ? await fileResponse(sql, doc.file, { download: true }) : null;
          return response ?? apiError(404, "Ese archivo no existe.");
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
