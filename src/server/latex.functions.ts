import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { isLatexName, LATEX_MAX_BYTES } from "@/domain/vault/latex";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { editableTarget, grantedDocOwner } from "@/server/share";
import { readBlob } from "@/server/blobs";
import { getDoc } from "@/server/vault";
import { compileLatex, storeLatex } from "@/server/latex";
import { checkExtension, extensionChosen } from "@/server/extensions";

/** Read, save and compile LaTeX documents; see server/latex.ts. */

const id = z.string().min(1).max(80);

async function readable(userId: string, docId: string, shareId?: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  if (!allows(profile, PERMISSION.notesRead)) return null;
  const ownerId = shareId
    ? ((await editableTarget(sql, userId, shareId, docId))?.ownerId ??
      (await grantedDocOwner(sql, userId, shareId, docId)))
    : userId;
  const doc = ownerId ? await getDoc(sql, ownerId, docId) : null;
  if (!doc?.file?.key || !isLatexName(doc.file.name)) return null;
  return { sql, profile, doc };
}

export const readLatex = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ docId: id, shareId: id.optional() }).parse(input))
  .handler(async ({ context, data }) => {
    const found = await readable(context.userId, data.docId, data.shareId);
    if (!found) return { ok: false as const, error: "Ese documento LaTeX no existe." };
    const bytes = await readBlob(found.sql, found.doc.file!.key!);
    if (!bytes) return { ok: false as const, error: "No se pudo abrir el documento." };
    return { ok: true as const, content: new TextDecoder().decode(bytes) };
  });

export const saveLatex = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({ docId: id, shareId: id.optional(), content: z.string().max(LATEX_MAX_BYTES) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    return storeLatex(sql, { id: context.userId, profile }, data);
  });

/**
 * Compile the source being edited (saved or not) of a document the caller can read. The PDF
 * comes back as base64 for the preview; it is not stored.
 */
export const compileLatexDoc = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({ docId: id, shareId: id.optional(), source: z.string().max(LATEX_MAX_BYTES) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const found = await readable(context.userId, data.docId, data.shareId);
    if (!found) return { ok: false as const, error: "Ese documento LaTeX no existe.", log: "" };
    if (!(await extensionChosen(found.sql, "latex")))
      return { ok: false as const, error: "La extensión LaTeX está desactivada.", log: "" };
    if (!(await checkExtension("latex")).ok)
      return {
        ok: false as const,
        error: "El compilador de LaTeX no responde. Se podrá compilar cuando vuelva.",
        log: "",
      };
    const result = await compileLatex(context.userId, data.source);
    if (!result.ok) return result;
    return { ok: true as const, pdf: Buffer.from(result.pdf).toString("base64") };
  });
