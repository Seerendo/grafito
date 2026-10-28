import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { isDrawingName } from "@/domain/vault/drawing";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { editableTarget } from "@/server/share";
import { maxUploadBytes, putBlob } from "@/server/blobs";
import { newFileKey } from "@/server/files";
import { getDoc, replaceFile, VaultError } from "@/server/vault";

/**
 * Guarda un dibujo de Excalidraw (un archivo `.excalidraw`): como lo que
 * guarda el editor de Office, es una versión nueva del archivo, y los
 * guardados seguidos de la misma persona se agrupan (`autosave`).
 */

const id = z.string().min(1).max(80);

export const saveDrawing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ docId: id, shareId: id.optional(), content: z.string().min(2).max(60_000_000) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesEdit)) return { ok: false as const, error: "Tu rol no puede editar." };
    const ownerId = data.shareId
      ? ((await editableTarget(sql, context.userId, data.shareId, data.docId))?.ownerId ?? null)
      : context.userId;
    if (!ownerId) return { ok: false as const, error: "Ya no puedes editar este dibujo." };
    const doc = await getDoc(sql, ownerId, data.docId);
    if (!doc?.file?.key || !isDrawingName(doc.file.name)) return { ok: false as const, error: "Ese dibujo no existe." };
    try {
      const scene = JSON.parse(data.content) as { type?: unknown };
      if (scene.type !== "excalidraw") throw new Error("not a scene");
    } catch {
      return { ok: false as const, error: "El dibujo no es válido." };
    }
    const bytes = new TextEncoder().encode(data.content);
    if (bytes.byteLength > maxUploadBytes()) return { ok: false as const, error: "El dibujo es demasiado grande." };
    const key = newFileKey(ownerId);
    await putBlob(sql, key, bytes, doc.file.mime || "application/vnd.excalidraw+json");
    try {
      const saved = await replaceFile(sql, ownerId, data.docId, {
        key,
        size: bytes.byteLength,
        actor: profile.displayName || "Alguien",
        actorId: context.userId,
        autosave: true,
      });
      return { ok: true as const, updatedAt: saved.updatedAt };
    } catch (error) {
      if (error instanceof VaultError) return { ok: false as const, error: error.message };
      throw error;
    }
  });
