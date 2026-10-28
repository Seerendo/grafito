import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { apiCaller, apiError, failure, readJson } from "@/server/api";
import { storeDrawing } from "@/server/drawing";

const body = z.object({ shareId: z.string().min(1).max(80).optional(), content: z.string().min(2).max(60_000_000) });

/**
 * `POST /api/drawings/:id` con `{ content, shareId? }`: guarda un dibujo como
 * `saveDrawing`. Existe para el último guardado al cerrar o recargar la
 * página: el navegador lo manda con `keepalive`, que una función de servidor
 * no permite, y así no se pierde lo dibujado en el último instante.
 */
export const Route = createFileRoute("/api/drawings/$id")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const caller = await apiCaller(request);
          const parsed = body.safeParse(await readJson(request));
          if (!parsed.success) return apiError(400, "Se espera { content, shareId? }.");
          const result = await storeDrawing(caller.sql, { id: caller.userId, profile: caller.profile }, {
            docId: params.id,
            ...parsed.data,
          });
          return Response.json(result, { status: result.ok ? 200 : 400 });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
