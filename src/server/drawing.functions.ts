import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { isDrawingName } from "@/domain/vault/drawing";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { editableTarget, grantedDocOwner } from "@/server/share";
import { readBlob } from "@/server/blobs";
import { getDoc } from "@/server/vault";
import { storeDrawing } from "@/server/drawing";

/** Leer y guardar un dibujo de Excalidraw (un archivo `.excalidraw`). Ver `server/drawing.ts`. */

const id = z.string().min(1).max(80);

/**
 * El dibujo tal como está ahora en el servidor. Se lee así, y no por su
 * enlace firmado, porque cada guardado lo deja en un objeto nuevo y borra el
 * anterior (guardados agrupados): un enlace de hace un momento ya no sirve.
 */
export const readDrawing = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ docId: id, shareId: id.optional() }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesRead)) return { ok: false as const, error: "Sin permiso." };
    const ownerId = data.shareId
      ? ((await editableTarget(sql, context.userId, data.shareId, data.docId))?.ownerId ??
        (await grantedDocOwner(sql, context.userId, data.shareId, data.docId)))
      : context.userId;
    const doc = ownerId ? await getDoc(sql, ownerId, data.docId) : null;
    if (!doc?.file?.key || !isDrawingName(doc.file.name)) return { ok: false as const, error: "Ese dibujo no existe." };
    const bytes = await readBlob(sql, doc.file.key);
    if (!bytes) return { ok: false as const, error: "No se pudo abrir el dibujo." };
    return { ok: true as const, content: new TextDecoder().decode(bytes) };
  });

export const saveDrawing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ docId: id, shareId: id.optional(), content: z.string().min(2).max(60_000_000) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    return storeDrawing(sql, { id: context.userId, profile }, data);
  });
