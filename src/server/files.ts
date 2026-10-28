import { officeText } from "./office-text.ts";
import type { Sql } from "@/lib/db";
import type { Document, VaultFile } from "@/domain/vault/types";
import { deleteBlob, getBlob, putBlob, readBlob } from "./blobs";

/**
 * Archivos de la bóveda (solo servidor): claves, conversión de los archivos
 * antiguos (guardados como data URL dentro de la nota) y la respuesta HTTP que
 * los entrega con cabeceras seguras.
 *
 * Cada objeto vive en `vault/<userId>/<uuid>`: un navegador solo puede apuntar
 * a claves de su propio usuario.
 */

export function newFileKey(userId: string): string {
  return `vault/${userId}/${crypto.randomUUID()}`;
}

export function ownsKey(userId: string, key: string): boolean {
  return key.startsWith(`vault/${userId}/`) && !key.includes("..");
}

/**
 * Decodifica un data URL (`data:<mime>[;param…][;base64],<datos>`). Sin
 * `;base64` los datos van como texto, normalmente con %-escapes.
 */
export function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const data = match[3] ?? "";
  if (/;base64/i.test(match[2] ?? "")) return { mime: match[1] ?? "", bytes: Buffer.from(data, "base64") };
  let text = data;
  try {
    text = decodeURIComponent(data);
  } catch {
    /* sin escapes válidos: tal cual */
  }
  return { mime: match[1] ?? "", bytes: Buffer.from(text, "utf8") };
}

/**
 * Archivo que manda un navegador: si aún trae el contenido como data URL (una
 * caché antigua o las notas de ejemplo), se guarda en el almacén y se sustituye
 * por su clave. Una clave de otro usuario se rechaza.
 */
export async function storeIncomingFile(sql: Sql, userId: string, file: VaultFile | null): Promise<{ file: VaultFile | null; converted: boolean }> {
  if (!file) return { file: null, converted: false };
  if (file.key) {
    if (!ownsKey(userId, file.key)) throw new Error("Ese archivo no es tuyo.");
    return { file: { name: file.name, mime: file.mime, key: file.key, size: file.size }, converted: false };
  }
  const decoded = file.dataUrl ? decodeDataUrl(file.dataUrl) : null;
  if (!decoded) return { file: { name: file.name, mime: file.mime }, converted: false };
  const key = newFileKey(userId);
  await putBlob(sql, key, decoded.bytes, file.mime || decoded.mime);
  return { file: { name: file.name, mime: file.mime, key, size: decoded.bytes.byteLength }, converted: true };
}

const migrated = new Set<string>();

/**
 * Pasa al almacén los archivos de `userId` que siguen dentro de la nota
 * (`file_data`), una vez por proceso. Les da una revisión nueva para que los
 * navegadores bajen la versión con clave y suelten el contenido de su caché.
 */
export async function migrateLegacyFiles(sql: Sql, userId: string, nextRevision: () => Promise<number>): Promise<void> {
  if (migrated.has(userId)) return;
  const rows = await sql<{ id: string; file_mime: string | null; file_data: string }>`
    select id, file_mime, file_data from vault_doc
    where user_id = ${userId} and file_data is not null and file_key is null
  `;
  if (rows.length > 0) {
    const rev = await nextRevision();
    for (const row of rows) {
      const decoded = decodeDataUrl(row.file_data);
      if (!decoded) continue;
      const key = newFileKey(userId);
      await putBlob(sql, key, decoded.bytes, row.file_mime || decoded.mime);
      await sql`
        update vault_doc set file_key = ${key}, file_size = ${decoded.bytes.byteLength}, file_data = null, rev = ${rev}
        where user_id = ${userId} and id = ${row.id}
      `;
    }
  }
  migrated.add(userId);
}

export async function removeFile(sql: Sql, key: string | null | undefined): Promise<void> {
  if (key) await deleteBlob(sql, key);
}

/** Borra los archivos de una cuenta antes de eliminarla (sus notas se borran en cascada). */
export async function removeUserFiles(sql: Sql, userId: string): Promise<void> {
  const rows = await sql<{ file_key: string }>`
    select file_key from vault_doc where user_id = ${userId} and file_key is not null
    union
    select file_key from vault_doc_version where user_id = ${userId} and file_key is not null
  `;
  for (const row of rows) await deleteBlob(sql, row.file_key);
  await sql`delete from file_blob where key like ${`vault/${userId}/%`}`;
}

const TEXTUAL = /json|xml|svg|csv|markdown|javascript|yaml/;

/**
 * Texto legible de un archivo: los de texto (Markdown, JSON, SVG, CSV…), los
 * documentos de Office y OpenDocument, y los PDF con texto.
 */
export async function fileText(sql: Sql, doc: Document, max = 20_000): Promise<string | null> {
  const file = doc.file;
  if (!file) return null;
  const mime = (file.mime || "").toLowerCase();
  const office = /\.(docx|docm|pptx|xlsx|xlsm|odt|ods|odp)$/i.test(file.name);
  const drawing = /\.excalidraw$/i.test(file.name);
  // Antes que el tipo: el de Word o Excel lleva «xml» (`…openxmlformats…`) y
  // no es texto, es un ZIP.
  const textual =
    !office && !drawing && (mime.startsWith("text/") || TEXTUAL.test(mime) || /\.(md|txt|csv|json|svg|xml|ya?ml)$/i.test(file.name));
  const pdf = mime === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!textual && !office && !pdf && !drawing) return null;
  let bytes: Uint8Array | null = null;
  if (file.key) bytes = await readBlob(sql, file.key);
  else if (file.dataUrl) bytes = decodeDataUrl(file.dataUrl)?.bytes ?? null;
  if (!bytes) return null;
  let raw: string | null;
  if (textual) raw = Buffer.from(bytes).toString("utf8");
  // Word, Excel, PowerPoint y OpenDocument: su texto (ver `office-text.ts`).
  else if (office) raw = officeText(file.name, bytes);
  // Un dibujo de Excalidraw: sus textos, no el JSON de la escena.
  else if (drawing) raw = drawingText(bytes);
  else raw = await pdfText(bytes);
  if (!raw) return null;
  return raw.length > max ? `${raw.slice(0, max)}\n…(recortado)` : raw;
}

/** Los textos de un dibujo de Excalidraw, uno por línea; `null` si no tiene. */
function drawingText(bytes: Uint8Array): string | null {
  try {
    const scene = JSON.parse(Buffer.from(bytes).toString("utf8")) as { elements?: { type?: string; text?: string; isDeleted?: boolean }[] };
    const texts = (scene.elements ?? [])
      .filter((element) => element.type === "text" && !element.isDeleted && element.text?.trim())
      .map((element) => element.text!.trim());
    return texts.length ? texts.join("\n") : null;
  } catch {
    return null;
  }
}

/** El texto de un PDF (con PDF.js, vía `unpdf`); `null` si no tiene texto, p. ej. un escaneado. */
async function pdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(document, { mergePages: true });
    const value = (Array.isArray(text) ? text.join("\n\n") : text).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Tipos que el navegador podría ejecutar si se abren directamente: siempre como descarga y aislados. */
const ACTIVE = /svg|html|xml|javascript/i;

/**
 * Respuesta HTTP con el archivo. Imágenes, PDF, audio y vídeo se muestran;
 * el resto se descarga. Todo va con `nosniff` y una CSP sin scripts.
 */
export async function fileResponse(
  sql: Sql,
  file: { name: string; mime: string; key?: string | null; dataUrl?: string | null },
  options: { download: boolean; range?: string | null },
): Promise<Response | null> {
  const mime = file.mime || "application/octet-stream";
  const viewable = /^(image\/|video\/|audio\/)|^application\/pdf$/i.test(mime) && !ACTIVE.test(mime);
  const headers: Record<string, string> = {
    "content-type": mime,
    "content-disposition": `${viewable && !options.download ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=300",
    // El PDF se ve en un iframe de la propia app.
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'${ACTIVE.test(mime) ? "; sandbox" : ""}`,
  };
  if (file.key) {
    const blob = await getBlob(sql, file.key, options.range);
    if (!blob) return null;
    return new Response(blob.body as BodyInit, { status: blob.status, headers: { ...headers, ...blob.headers } });
  }
  const decoded = file.dataUrl ? decodeDataUrl(file.dataUrl) : null;
  if (!decoded) return null;
  return new Response(new Uint8Array(decoded.bytes), { headers: { ...headers, "content-length": String(decoded.bytes.byteLength) } });
}
