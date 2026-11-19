import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import { isLatexName, LATEX_MAX_BYTES, LATEX_MIME } from "@/domain/vault/latex";
import { blockUnsafeBlob } from "./clamav";
import { newFileKey } from "./files";
import { putBlob } from "./blobs";
import type { UserProfile } from "./profile";
import { allows } from "./profile";
import { editableTarget } from "./share";
import { getDoc, replaceFile, VaultError } from "./vault";

/**
 * LaTeX documents: saving a new version of the .tex source and compiling it through the latex
 * service (docker/latex). LATEX_URL points at it (http://latex:8080 in Docker); empty turns
 * compilation off and the source can still be edited.
 */

export function latexUrl(): string | null {
  const raw = process.env.LATEX_URL;
  if (raw === undefined)
    return process.env.GRAFITO_FROM_DOCKER === "1" ? "http://latex:8080" : null;
  return raw.trim() || null;
}

export type CompileResult =
  { ok: true; pdf: Uint8Array } | { ok: false; error: string; log: string };

/** One compilation per person at a time. */
const running = new Set<string>();

export async function compileLatex(userId: string, source: string): Promise<CompileResult> {
  const url = latexUrl();
  if (!url) return { ok: false, error: "El compilador de LaTeX no está configurado.", log: "" };
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > LATEX_MAX_BYTES)
    return { ok: false, error: "El documento es demasiado grande.", log: "" };
  if (running.has(userId))
    return { ok: false, error: "Ya se está compilando otro documento tuyo.", log: "" };
  running.add(userId);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/compile`, {
      method: "POST",
      headers: { "content-type": "application/x-tex" },
      body: bytes,
      signal: AbortSignal.timeout(150_000),
    });
    if (response.ok) return { ok: true, pdf: new Uint8Array(await response.arrayBuffer()) };
    const body = (await response.json().catch(() => ({}))) as { error?: string; log?: string };
    return {
      ok: false,
      error: body.error || `El compilador respondió ${response.status}.`,
      log: body.log ?? "",
    };
  } catch {
    return { ok: false, error: "El compilador de LaTeX no está disponible.", log: "" };
  } finally {
    running.delete(userId);
  }
}

/** Save the source as a new version of the document (owner, or editor through a share). */
export async function storeLatex(
  sql: Sql,
  user: { id: string; profile: UserProfile },
  input: { docId: string; shareId?: string; content: string },
): Promise<{ ok: true; updatedAt: number } | { ok: false; error: string }> {
  if (!allows(user.profile, PERMISSION.notesEdit))
    return { ok: false, error: "Tu rol no puede editar." };
  const ownerId = input.shareId
    ? ((await editableTarget(sql, user.id, input.shareId, input.docId))?.ownerId ?? null)
    : user.id;
  if (!ownerId) return { ok: false, error: "Ya no puedes editar este documento." };
  const doc = await getDoc(sql, ownerId, input.docId);
  if (!doc?.file?.key || !isLatexName(doc.file.name))
    return { ok: false, error: "Ese documento LaTeX no existe." };
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > LATEX_MAX_BYTES)
    return { ok: false, error: "El documento es demasiado grande." };
  const key = newFileKey(ownerId);
  await putBlob(sql, key, bytes, doc.file.mime || LATEX_MIME);
  const blocked = await blockUnsafeBlob(sql, key);
  if (blocked) return { ok: false, error: blocked.message };
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
