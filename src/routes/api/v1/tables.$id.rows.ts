import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { addNamedRow, presentRow, readFields, tableDocument } from "@/server/table";

const bodySchema = z.object({ cells: z.record(z.string(), z.unknown()) });

/** `POST /api/v1/tables/:id/rows` con `{ cells }`. Las claves son los nombres de las columnas. */
export const Route = createFileRoute("/api/v1/tables/$id/rows")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesEdit, "Tu rol no puede cambiar esta tabla.");
          const doc = await tableDocument(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa tabla no existe.");
          const body = bodySchema.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { cells }.");
          const created = await addNamedRow(sql, userId, params.id, body.data.cells, profile.displayName || profile.loginName);
          if (!created.ok) return apiError(400, created.error);
          return json({ row: presentRow(await readFields(sql, userId, params.id), created.row) }, 201);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
