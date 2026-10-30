import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { createTable, listTables } from "@/server/table";

const createBody = z.object({
  title: z.string().min(1).max(200),
  portfolioId: z.string().min(1).max(80).nullable().optional(),
});

/**
 * `GET /api/v1/tables`: las tablas de la bóveda (archivos `.tabla`).
 * `POST /api/v1/tables` con `{ title, portfolioId? }`: crea una vacía.
 */
export const Route = createFileRoute("/api/v1/tables")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesRead, "Tu rol no puede leer la bóveda.");
          return json({ tables: await listTables(sql, userId) });
        } catch (error) {
          return failure(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.filesUpload, "Tu rol no puede crear tablas.");
          const body = createBody.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { title, portfolioId? }.");
          const table = await createTable(sql, userId, {
            title: body.data.title,
            portfolioId: body.data.portfolioId ?? null,
            actor: profile.displayName || profile.loginName,
          });
          return json({ table }, 201);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
