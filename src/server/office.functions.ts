import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import {
  displayNameOf,
  editorUrl,
  isOfficeName,
  issueOfficeToken,
  officeEnabled,
  officeReachProblem,
} from "@/server/office";
import { allows, readUserProfile } from "@/server/profile";
import { editableTarget, grantedDocOwner } from "@/server/share";
import { getDoc } from "@/server/vault";

/** Whether this server has an Office editor. */
export const officeStatus = createServerFn({ method: "GET" }).handler(async () => ({
  enabled: officeEnabled(),
}));

/**
 * Authorize owned/shared Office access and return editor URL plus signed token. Open read-only
 * without edit permission.
 */
export const officeSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        docId: z.string().min(1).max(80),
        shareId: z.string().min(1).max(80).optional(),
        origin: z.string().url().max(200),
        lang: z.enum(["es", "en"]).default("es"),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    if (!officeEnabled())
      return {
        ok: false as const,
        error: "El editor de Office no está activado en este servidor.",
      };
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesRead))
      return { ok: false as const, error: "Tu rol no puede abrir documentos." };
    let ownerId: string | null = context.userId;
    let canWrite = allows(profile, PERMISSION.notesEdit);
    if (data.shareId) {
      const editable = canWrite
        ? await editableTarget(sql, context.userId, data.shareId, data.docId)
        : null;
      ownerId =
        editable?.ownerId ?? (await grantedDocOwner(sql, context.userId, data.shareId, data.docId));
      canWrite = Boolean(editable);
    }
    const doc = ownerId ? await getDoc(sql, ownerId, data.docId) : null;
    if (!ownerId || !doc?.file?.key || !isOfficeName(doc.file.name)) {
      return { ok: false as const, error: "Ese documento no se puede abrir en el editor." };
    }
    // Report incompatible server settings instead of displaying a blank editor or retrying permanent configuration failures.
    const problem = officeReachProblem(new URL(data.origin).origin);
    if (problem) return { ok: false as const, error: problem, setup: true as const };
    try {
      const url = await editorUrl(
        doc.id,
        doc.file.name,
        canWrite,
        data.lang,
        new URL(data.origin).origin,
      );
      const session = issueOfficeToken({
        d: doc.id,
        o: ownerId,
        u: context.userId,
        n: await displayNameOf(sql, context.userId),
        w: canWrite,
        p: new URL(data.origin).origin,
        ...(data.shareId ? { s: data.shareId } : {}),
      });
      return {
        ok: true as const,
        url,
        token: session.token,
        expiresAt: session.expiresAt,
        canWrite,
      };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "No se pudo abrir el editor.",
      };
    }
  });
