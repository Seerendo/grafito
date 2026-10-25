import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { MAX_CONTENT, createNote, listDocs } from "@/server/vault";

const createBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(MAX_CONTENT).optional(),
  portfolioId: z.string().min(1).max(80).nullable().optional(),
});

/**
 * `GET /api/v1/notes?portfolio=<id|root>&q=<texto>&limit=<n>`: notas y archivos (sin contenido).
 * `POST /api/v1/notes` con `{ title, content?, portfolioId? }`: crea una nota Markdown.
 */
export const Route = createFileRoute("/api/v1/notes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesRead, "Tu rol no puede leer la bóveda.");
          const params = new URL(request.url).searchParams;
          const portfolio = params.get("portfolio");
          const notes = await listDocs(sql, userId, {
            portfolioId: portfolio === null ? undefined : portfolio === "root" ? null : portfolio,
            query: params.get("q") ?? undefined,
            limit: Number(params.get("limit")) || undefined,
          });
          return json({ notes });
        } catch (error) {
          return failure(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesCreate, "Tu rol no puede crear notas.");
          const body = createBody.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { title, content?, portfolioId? }.");
          const note = await createNote(sql, userId, {
            title: body.data.title,
            content: body.data.content ?? "",
            portfolioId: body.data.portfolioId ?? null,
            actor: profile.displayName,
          });
          return json({ note }, 201);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
