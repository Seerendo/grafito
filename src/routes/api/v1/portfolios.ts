import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { createPortfolio, listPortfolios } from "@/server/vault";

const createBody = z.object({ name: z.string().min(1).max(120), parentId: z.string().min(1).max(80).nullable().optional() });

/** `GET /api/v1/portfolios` y `POST /api/v1/portfolios` con `{ name, parentId? }`. */
export const Route = createFileRoute("/api/v1/portfolios")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesRead, "Tu rol no puede leer la bóveda.");
          return json({ portfolios: await listPortfolios(sql, userId) });
        } catch (error) {
          return failure(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.portfoliosManage, "Tu rol no puede crear portafolios.");
          const body = createBody.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { name, parentId? }.");
          const portfolio = await createPortfolio(sql, userId, { name: body.data.name, parentId: body.data.parentId ?? null });
          return json({ portfolio }, 201);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
