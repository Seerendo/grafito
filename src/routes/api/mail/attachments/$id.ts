import { createFileRoute } from "@tanstack/react-router";
import { safeFileName } from "@/domain/mail/message";
import { apiError } from "@/server/api";
import { readToken } from "@/server/file-links";
import { fileResponse } from "@/server/files";
import { logEvent } from "@/server/telemetry";

/**
 * GET /api/mail/attachments/:id?t=… serves a downloaded mail attachment with a link signed for its
 * owner and ten minutes (mailbox.functions.ts → mailAttachment). Only a file the antivirus passed
 * (or that was stored while scanning was off) is served, with the same safe headers as vault
 * files: types that could run code are always downloaded, never shown.
 */
export const Route = createFileRoute("/api/mail/attachments/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const token = readToken<{ a?: string; u?: string; d?: number }>(
          url.searchParams.get("t") ?? "",
        );
        if (!token || token.a !== params.id || !token.u)
          return apiError(403, "El enlace caducó. Vuelve a abrir el adjunto.");
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        const rows = await sql<{
          filename: string;
          content_type: string;
          storage_key: string | null;
          download_status: string;
          antivirus_status: string;
        }>`
          select filename, content_type, storage_key, download_status, antivirus_status from mail_attachment
          where id = ${params.id} and user_id = ${token.u} limit 1
        `;
        const row = rows[0];
        if (!row || row.download_status !== "ready" || !row.storage_key)
          return apiError(404, "Ese adjunto no está disponible.");
        if (row.antivirus_status !== "clean" && row.antivirus_status !== "off")
          return apiError(422, "Ese adjunto no pasó el antivirus.");
        const response = await fileResponse(
          sql,
          {
            name: safeFileName(row.filename, "adjunto"),
            mime: row.content_type || "application/octet-stream",
            key: row.storage_key,
          },
          { download: token.d === 1, range: request.headers.get("range") },
        );
        if (!response) {
          logEvent("mail.attachment.missing", { attachment: params.id });
          return apiError(404, "El adjunto ya no está guardado. Ábrelo otra vez para descargarlo.");
        }
        response.headers.set("cache-control", "private, no-store");
        return response;
      },
    },
  },
});
