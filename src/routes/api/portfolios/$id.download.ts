import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { allows } from "@/server/profile";
import { apiCaller, apiError, failure } from "@/server/api";
import { readToken } from "@/server/file-links";
import { planExport } from "@/server/export";
import type { ZipTicket } from "@/server/export.functions";
import { zipStream } from "@/server/zip";

/**
 * `GET /api/portfolios/:id/download`: el portafolio (con sus subportafolios)
 * como .zip; `all` es toda la bóveda. Acceso con el enlace firmado que da la
 * app (`t`, ver `export.functions.ts`) o con un token personal de la API.
 */
export const Route = createFileRoute("/api/portfolios/$id/download")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const url = new URL(request.url);
          const given = url.searchParams.get("t");
          let ownerId: string;
          let allow: { notes: boolean; files: boolean };
          const { getSql } = await import("@/lib/db");
          let sql = await getSql();
          if (given) {
            const ticket = readToken<ZipTicket>(given);
            if (!ticket || ticket.kind !== "zip" || ticket.portfolioId !== params.id) {
              return apiError(403, "El enlace caducó. Vuelve a pedir la descarga.");
            }
            ownerId = ticket.ownerId;
            allow = { notes: ticket.notes, files: ticket.files };
          } else {
            const caller = await apiCaller(request);
            sql = caller.sql;
            ownerId = caller.userId;
            allow = {
              notes: allows(caller.profile, PERMISSION.notesExport),
              files: allows(caller.profile, PERMISSION.filesDownload),
            };
            if (!allow.notes && !allow.files) return apiError(403, "Tu rol no puede descargar.");
          }
          const plan = await planExport(sql, ownerId, params.id, allow);
          return new Response(zipStream(plan.entries), {
            headers: {
              "content-type": "application/zip",
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${plan.name}.zip`)}`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
