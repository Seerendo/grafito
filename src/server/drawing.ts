import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import { isDrawingName } from "@/domain/vault/drawing";
import type { UserProfile } from "@/server/profile";
import { allows } from "@/server/profile";
import { editableTarget } from "@/server/share";
import { maxUploadBytes, putBlob } from "@/server/blobs";
import { newFileKey } from "@/server/files";
import { getDoc, replaceFile, VaultError } from "@/server/vault";

/**
 * Guarda un dibujo de Excalidraw (solo servidor). Lo usan `saveDrawing` (el
 * guardado normal) y `POST /api/drawings/:id` (el último guardado al cerrar
 * la página, con `keepalive`). Como lo que guarda el editor de Office, es una
 * versión nueva del archivo, y los guardados seguidos de la misma persona se
 * agrupan (`autosave`).
 */
export async function storeDrawing(
  sql: Sql,
  user: { id: string; profile: UserProfile },
  input: { docId: string; shareId?: string; content: string },
): Promise<{ ok: true; updatedAt: number } | { ok: false; error: string }> {
  if (!allows(user.profile, PERMISSION.notesEdit)) return { ok: false, error: "Tu rol no puede editar." };
  const ownerId = input.shareId
    ? ((await editableTarget(sql, user.id, input.shareId, input.docId))?.ownerId ?? null)
    : user.id;
  if (!ownerId) return { ok: false, error: "Ya no puedes editar este dibujo." };
  const doc = await getDoc(sql, ownerId, input.docId);
  if (!doc?.file?.key || !isDrawingName(doc.file.name)) return { ok: false, error: "Ese dibujo no existe." };
  try {
    const scene = JSON.parse(input.content) as { type?: unknown };
    if (scene.type !== "excalidraw") throw new Error("not a scene");
  } catch {
    return { ok: false, error: "El dibujo no es válido." };
  }
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > maxUploadBytes()) return { ok: false, error: "El dibujo es demasiado grande." };
  const key = newFileKey(ownerId);
  await putBlob(sql, key, bytes, doc.file.mime || "application/vnd.excalidraw+json");
  try {
    const saved = await replaceFile(sql, ownerId, input.docId, {
      key,
      size: bytes.byteLength,
      actor: user.profile.displayName || "Alguien",
      actorId: user.id,
      autosave: true,
    });
    return { ok: true, updatedAt: saved.updatedAt };
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
}
