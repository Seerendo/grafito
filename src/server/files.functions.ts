import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { signedFileUrl } from "@/server/file-links";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { logEvent } from "@/server/telemetry";
import { getDoc } from "@/server/vault";

/**
 * Owned file view/download links last an hour; app/files.ts refreshes them before expiry. When
 * there is no link, `reason` says why, so the viewer can tell a document the server does not
 * have yet ("missing") from one it may not read ("forbidden") or one without stored bytes
 * ("empty").
 */
export const fileLink = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ docId: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesRead))
      return { ok: false as const, reason: "forbidden" as const };
    const doc = await getDoc(sql, context.userId, data.docId);
    if (!doc) {
      logEvent("file.link.missing", {});
      return { ok: false as const, reason: "missing" as const };
    }
    if (!doc.file || (!doc.file.key && !doc.file.dataUrl))
      return { ok: false as const, reason: "empty" as const };
    return {
      ok: true as const,
      url: signedFileUrl(doc.id, context.userId),
      downloadUrl: allows(profile, PERMISSION.filesDownload)
        ? signedFileUrl(doc.id, context.userId, true)
        : null,
    };
  });

const VIEWER_STAGES = ["link", "pdf", "office", "image", "media"] as const;
export type ViewerStage = (typeof VIEWER_STAGES)[number];

/**
 * A viewer in the browser could not show a file: which stage failed (getting its link, reading
 * the PDF, opening the Office editor, an image or media element) and how. Logged as one line;
 * no file names, contents or links.
 */
export const viewerEvent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        stage: z.enum(VIEWER_STAGES),
        kind: z
          .string()
          .max(40)
          .regex(/^[A-Za-z0-9._ -]*$/),
        ms: z.number().int().min(0).max(3_600_000),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireLease(context.userId);
    logEvent("viewer.failed", data);
    return { ok: true as const };
  });
