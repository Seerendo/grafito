import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { maxUploadBytes, PART_SIZE, startUpload } from "@/server/blobs";
import { newFileKey } from "@/server/files";

/**
 * Subida de archivos por partes (ver `server/blobs.ts`):
 *
 *   POST /api/files/uploads            { name, mime, size }   → { key, uploadId, partSize }
 *   PUT  /api/files/uploads/part?key&uploadId&part  (bytes)    → { etag }
 *   POST /api/files/uploads/complete   { key, uploadId, parts } → { key, size }
 *   POST /api/files/uploads/complete   { key, uploadId, abort: true }
 *
 * La clave queda bajo el usuario que sube; la nota que la usa llega después
 * con la sincronización.
 */

const start = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().max(120),
  size: z.number().int().min(0),
});

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export const Route = createFileRoute("/api/files/uploads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.filesUpload, "Tu rol no permite subir archivos.");
          const body = start.safeParse(await readJson(request));
          if (!body.success) return apiError(400, "Se espera { name, mime, size }.");
          const max = maxUploadBytes();
          if (body.data.size > max) return apiError(413, `«${body.data.name}» supera el límite de ${megabytes(max)}.`);
          const key = newFileKey(userId);
          const uploadId = await startUpload(sql, key, body.data.mime || "application/octet-stream");
          return json({ key, uploadId, partSize: PART_SIZE });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
