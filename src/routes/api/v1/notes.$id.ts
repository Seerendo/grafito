import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION, deletePermission } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { MAX_CONTENT, deleteDoc, fileText, getDoc, updateNote } from "@/server/vault";

const patchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(MAX_CONTENT).optional(),
  portfolioId: z.string().min(1).max(80).nullable().optional(),
});

/** `GET`, `PATCH` (`{ title?, content?, portfolioId? }`) y `DELETE /api/v1/notes/:id`. */
export const Route = createFileRoute("/api/v1/notes/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesRead, "Tu rol no puede leer la bóveda.");
          const doc = await getDoc(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa nota no existe.");
          const { file, ...rest } = doc;
          return json({
            note: {
              ...rest,
              file: file ? { name: file.name, mime: file.mime, url: `/api/v1/notes/${doc.id}/file`, text: fileText(doc) } : null,
            },
          });
        } catch (error) {
          return failure(error);
        }
      },
      PATCH: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesEdit, "Tu rol no puede editar notas.");
          const body = patchBody.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { title?, content?, portfolioId? }.");
          const note = await updateNote(sql, userId, params.id, { ...body.data, actor: profile.displayName });
          return json({ note });
        } catch (error) {
          return failure(error);
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          const doc = await getDoc(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa nota no existe.");
          requirePermission(profile, deletePermission(doc.kind), "Tu rol no puede borrar esto.");
          await deleteDoc(sql, userId, params.id);
          return new Response(null, { status: 204 });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
