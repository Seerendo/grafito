import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { signedFileUrl } from "@/server/file-links";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { getDoc } from "@/server/vault";

/**
 * Enlaces para ver y descargar un archivo propio. Caducan en una hora; el
 * cliente los pide de nuevo antes (`app/files.ts`).
 */
export const fileLink = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ docId: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesRead)) return null;
    const doc = await getDoc(sql, context.userId, data.docId);
    if (!doc?.file || (!doc.file.key && !doc.file.dataUrl)) return null;
    return {
      url: signedFileUrl(doc.id, context.userId),
      downloadUrl: allows(profile, PERMISSION.filesDownload) ? signedFileUrl(doc.id, context.userId, true) : null,
    };
  });
