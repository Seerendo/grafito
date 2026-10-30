import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { FIELD_TYPES } from "@/domain/vault/table";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { presentField, readFields, saveField, tableDocument } from "@/server/table";

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(FIELD_TYPES).optional(),
  choices: z.array(z.string().max(120)).max(100).optional(),
  formula: z.string().max(500).nullable().optional(),
  relatedTableId: z.string().max(80).nullable().optional(),
});

/** `POST /api/v1/tables/:id/fields` con `{ name, type?, choices?, formula?, relatedTableId? }`. */
export const Route = createFileRoute("/api/v1/tables/$id/fields")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.notesEdit, "Tu rol no puede cambiar esta tabla.");
          const doc = await tableDocument(sql, userId, params.id);
          if (!doc) return apiError(404, "Esa tabla no existe.");
          const body = bodySchema.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { name, type?, choices?, formula?, relatedTableId? }.");
          const id = randomUUID();
          const saved = await saveField(sql, userId, params.id, {
            id,
            name: body.data.name,
            type: body.data.type ?? (body.data.formula ? "formula" : "text"),
            choices: body.data.choices,
            formula: body.data.formula,
            relatedTableId: body.data.relatedTableId,
          });
          if (!saved.ok) return apiError(400, saved.error);
          const field = (await readFields(sql, userId, params.id)).find((item) => item.id === id);
          return json({ field: field ? presentField(field) : { id, name: body.data.name } }, 201);
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
