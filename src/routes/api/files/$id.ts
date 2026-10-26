import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, requirePermission } from "@/server/api";
import { verifyFileUrl } from "@/server/file-links";
import { fileResponse } from "@/server/files";
import { publicDocOwner } from "@/server/share";
import { getDoc } from "@/server/vault";

/**
 * `GET /api/files/:id`: el archivo de un documento. Acceso, en este orden:
 *  - enlace firmado (`o`, `e`, `s`, `d`), que da la propia app tras comprobar
 *    permisos (`server/file-links.ts`);
 *  - `token` de un enlace público que incluya el documento;
 *  - token personal de la API o sesión, para archivos propios.
 * `download` lo entrega como descarga.
 */
export const Route = createFileRoute("/api/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const url = new URL(request.url);
          const { getSql } = await import("@/lib/db");
          let sql = await getSql();
          let ownerId: string | null = null;
          let download = url.searchParams.has("download");
          const signed = url.searchParams.has("s") ? verifyFileUrl(params.id, url.searchParams) : null;
          const token = url.searchParams.get("token");
          if (url.searchParams.has("s")) {
            if (!signed) return apiError(403, "El enlace caducó. Vuelve a abrir el documento.");
            ownerId = signed.ownerId;
            download = signed.download;
          } else if (token) {
            ownerId = await publicDocOwner(sql, token, params.id);
          } else {
            const caller = await apiCaller(request);
            requirePermission(
              caller.profile,
              download ? PERMISSION.filesDownload : PERMISSION.notesRead,
              "Tu rol no puede abrir este archivo.",
            );
            sql = caller.sql;
            ownerId = caller.userId;
          }
          const doc = ownerId ? await getDoc(sql, ownerId, params.id) : null;
          const response = doc?.file
            ? await fileResponse(sql, doc.file, { download, range: request.headers.get("range") })
            : null;
          return response ?? apiError(404, "Ese archivo no existe.");
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
