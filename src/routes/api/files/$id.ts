import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, requirePermission } from "@/server/api";
import { verifyFileUrl } from "@/server/file-links";
import { fileResponse } from "@/server/files";
import { liveShareCovers, publicDocOwner } from "@/server/share";
import { logEvent, since } from "@/server/telemetry";
import { getDoc } from "@/server/vault";

/**
 * GET /api/files/:id authorizes signed links first, then public-share tokens, then personal API
 * tokens or sessions for owned files. Signed links are issued after permission checks. download
 * requests attachment delivery.
 */
export const Route = createFileRoute("/api/files/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const started = performance.now();
        let stage = "auth";
        try {
          const url = new URL(request.url);
          const { getSql } = await import("@/lib/db");
          let sql = await getSql();
          let ownerId: string | null = null;
          let download = url.searchParams.has("download");
          const signed = url.searchParams.has("s")
            ? verifyFileUrl(params.id, url.searchParams)
            : null;
          const token = url.searchParams.get("token");
          if (url.searchParams.has("s")) {
            if (!signed) return apiError(403, "El enlace caducó. Vuelve a abrir el documento.");
            if (
              signed.shareId &&
              !(await liveShareCovers(sql, signed.shareId, signed.ownerId, params.id))
            )
              return apiError(403, "Ya no tienes acceso a este archivo.");
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
          stage = "metadata";
          const doc = ownerId ? await getDoc(sql, ownerId, params.id) : null;
          stage = "storage";
          const response = doc?.file
            ? await fileResponse(sql, doc.file, { download, range: request.headers.get("range") })
            : null;
          const ms = since(started);
          // Reads are frequent (a PDF asks for ranges): only misses and slow ones are logged.
          if (!response)
            logEvent("file.read.missing", { known: Boolean(doc), stored: Boolean(doc?.file), ms });
          else if (ms > 1000) logEvent("file.read.slow", { status: response.status, ms });
          return response ?? apiError(404, "Ese archivo no existe.");
        } catch (error) {
          if (!(error instanceof Response))
            logEvent("file.read.failed", {
              stage,
              ms: since(started),
              error: error instanceof Error ? error.name : "error",
            });
          return failure(error);
        }
      },
    },
  },
});
