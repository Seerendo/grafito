import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, readJson, requirePermission } from "@/server/api";
import { abortUpload, deleteBlob, finishUpload, maxUploadBytes } from "@/server/blobs";
import { checkSpace } from "@/server/space";
import { mayUpload, uploadTarget } from "@/server/upload-target";

/** `POST /api/files/uploads/complete`: cierra o cancela una subida (ver `uploads.ts`). */

const finish = z.object({
  key: z.string().min(1).max(200),
  uploadId: z.string().min(1).max(1000),
  parts: z.array(z.object({ part: z.number().int().min(1).max(10_000), etag: z.string().max(200) })).max(10_000).default([]),
  abort: z.boolean().optional(),
  portfolioId: z.string().min(1).max(80).nullable().optional(),
  shareId: z.string().min(1).max(80).nullable().optional(),
});

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function completeUpload(request: Request): Promise<Response> {
  try {
    const { sql, userId, profile } = await apiCaller(request);
    requirePermission(profile, PERMISSION.filesUpload, "Tu rol no permite subir archivos.");
    const body = finish.safeParse(await readJson(request));
    if (!body.success) return apiError(400, "Se espera { key, uploadId, parts }.");
    if (!(await mayUpload(sql, userId, body.data.key, body.data.shareId ?? null))) return apiError(403, "Esa subida no es tuya.");
    if (body.data.abort) {
      await abortUpload(sql, body.data.key, body.data.uploadId);
      return json({ ok: true });
    }
    const size = await finishUpload(sql, body.data.key, body.data.uploadId, body.data.parts);
    const max = maxUploadBytes();
    if (size > max) {
      await deleteBlob(sql, body.data.key);
      return apiError(413, `El archivo supera el límite de ${megabytes(max)}.`);
    }
    // Con el tamaño real: lo declarado al empezar podía no coincidir.
    const target = await uploadTarget(sql, userId, body.data);
    const full =
      typeof target === "string" ? target : await checkSpace(sql, { ...target, uploaderId: userId, bytes: size });
    if (full) {
      await deleteBlob(sql, body.data.key);
      return apiError(413, full);
    }
    return json({ key: body.data.key, size });
  } catch (error) {
    return failure(error);
  }
}

export const Route = createFileRoute("/api/files/uploads/complete")({
  server: { handlers: { POST: ({ request }) => completeUpload(request) } },
});
