import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { deleteRows, patchNamedCells, presentRow, readFields, tableDocument } from "@/server/table";

const bodySchema = z.object({ cells: z.record(z.string(), z.unknown()) });

/** `PATCH` (`{ cells }`) y `DELETE /api/v1/tables/:id/rows/:rowId`. */
export const Route = createFileRoute("/api/v1/tables/$id/rows/$rowId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesEdit, "Tu rol no puede cambiar esta tabla.");
          const doc = await tableDocument(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa tabla no existe.");
          const body = bodySchema.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { cells }.");
          const saved = await patchNamedCells(
            sql,
            userId,
            params.id,
            params.rowId,
            body.data.cells,
            profile.displayName || profile.loginName,
          );
          if (!saved.ok) return apiError(saved.error === "Esa fila ya no existe." ? 404 : 400, saved.error);
          return json({ row: presentRow(await readFields(sql, userId, params.id), saved.row) });
        } catch (error) {
          return failure(error);
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesEdit, "Tu rol no puede cambiar esta tabla.");
          const doc = await tableDocument(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa tabla no existe.");
          const found = await sql<{ id: string }>`
            select id from data_row
            where owner_id = ${userId} and doc_id = ${params.id} and id = ${params.rowId} and not deleted limit 1
          `;
          if (!found[0]) return apiError(404, "Esa fila ya no existe.");
          await deleteRows(sql, userId, params.id, [params.rowId], profile.displayName || profile.loginName);
          return new Response(null, { status: 204 });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
