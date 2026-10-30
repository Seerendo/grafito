import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { MAX_ROWS } from "@/domain/vault/table";
import { apiCaller, apiError, failure, json, requirePermission } from "@/server/api";
import { presentField, presentRow, readTable, tableDocument } from "@/server/table";

/** `GET /api/v1/tables/:id?q=<texto>&limit=<n>`: columnas, filas y fórmulas calculadas. */
export const Route = createFileRoute("/api/v1/tables/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesRead, "Tu rol no puede leer la bóveda.");
          const doc = await tableDocument(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa tabla no existe.");
          const table = await readTable(sql, userId, params.id, true);
          const query = new URL(request.url).searchParams;
          const needle = (query.get("q") ?? "").trim().toLowerCase();
          const limit = Math.min(MAX_ROWS, Math.max(1, Number(query.get("limit")) || 500));
          const rows = (needle
            ? table.rows.filter((row) => JSON.stringify(presentRow(table.fields, row)).toLowerCase().includes(needle))
            : table.rows
          ).slice(0, limit);
          return json({
            table: {
              id: params.id,
              title: doc.title,
              fields: table.fields.map(presentField),
              rows: rows.map((row) => presentRow(table.fields, row)),
              layout: table.layout,
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
