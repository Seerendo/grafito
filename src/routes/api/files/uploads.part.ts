import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { apiCaller, apiError, failure, json, requirePermission } from "@/server/api";
import { PART_SIZE, uploadPart } from "@/server/blobs";
import { ownsKey } from "@/server/files";

/** `PUT /api/files/uploads/part?key&uploadId&part`: una parte de una subida (ver `uploads.ts`). */
export const Route = createFileRoute("/api/files/uploads/part")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        try {
          const { sql, userId, profile } = await apiCaller(request);
          requirePermission(profile, PERMISSION.filesUpload, "Tu rol no permite subir archivos.");
          const url = new URL(request.url);
          const key = url.searchParams.get("key") ?? "";
          const uploadId = url.searchParams.get("uploadId") ?? "";
          const part = Number(url.searchParams.get("part"));
          if (!ownsKey(userId, key) || !uploadId) return apiError(403, "Esa subida no es tuya.");
          if (!Number.isInteger(part) || part < 1 || part > 10_000) return apiError(400, "Número de parte no válido.");
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > PART_SIZE) return apiError(413, "La parte es demasiado grande.");
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength > PART_SIZE) return apiError(413, "La parte es demasiado grande.");
          return json({ etag: await uploadPart(sql, key, uploadId, part, bytes) });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
