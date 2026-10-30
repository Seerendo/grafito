import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, requirePermission } from "@/server/api";
import { rowHistory, tableDocument } from "@/server/table";

/** `GET /api/v1/tables/:id/rows/:rowId/history`: los últimos cambios de la fila. */
export const Route = createFileRoute("/api/v1/tables/$id/rows/$rowId/history")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesRead, "Tu rol no puede leer la bóveda.");
          const doc = await tableDocument(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa tabla no existe.");
          const found = await sql<{ id: string }>`
            select id from data_row
            where owner_id = ${userId} and doc_id = ${params.id} and id = ${params.rowId} and not deleted limit 1
          `;
          if (!found[0]) return apiError(404, "Esa fila ya no existe.");
          return json({ history: await rowHistory(sql, userId, params.id, params.rowId) });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
