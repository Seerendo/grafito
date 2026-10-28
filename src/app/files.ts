import { uuid } from "@/lib/uuid";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Document, VaultFile } from "@/domain/vault/types";
import { bearerHeader } from "@/lib/auth/bearer";
import { fileLink } from "@/server/files.functions";
import { t } from "@/app/i18n";

/**
 * Archivos en el cliente: subida por partes a `/api/files/uploads`, enlaces
 * firmados para ver y descargar, y el progreso de las subidas en curso.
 */

export type FileLinks = { url: string; downloadUrl: string | null };

type Upload = { id: string; name: string; sent: number; total: number };

export const useUploads = create<{ uploads: Upload[] }>(() => ({ uploads: [] }));

function track(upload: Upload | null, id: string): void {
  useUploads.setState((state) => ({
    uploads: upload ? [...state.uploads.filter((item) => item.id !== id), upload] : state.uploads.filter((item) => item.id !== id),
  }));
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.headers as Record<string, string> | undefined), ...bearerHeader() },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || t("El servidor respondió {0}.", { 0: response.status }));
  return body;
}

/**
 * Sube un archivo por partes. Devuelve su clave y tamaño, o lanza un Error con
 * el motivo. `target`: el portafolio donde quedará (para el espacio) y, si es
 * uno compartido conmigo, su `shareId`.
 */
export async function uploadVaultFile(
  file: File,
  target: { portfolioId?: string | null; shareId?: string } = {},
): Promise<{ key: string; size: number }> {
  const id = uuid();
  const mime = file.type || "application/octet-stream";
  track({ id, name: file.name, sent: 0, total: file.size }, id);
  let started: { key: string; uploadId: string; partSize: number } | null = null;
  try {
    started = await call<{ key: string; uploadId: string; partSize: number }>("/api/files/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, mime, size: file.size, ...target }),
    });
    const parts: { part: number; etag: string }[] = [];
    let offset = 0;
    let part = 1;
    do {
      const chunk = file.slice(offset, offset + started.partSize);
      const query = new URLSearchParams({ key: started.key, uploadId: started.uploadId, part: String(part) });
      if (target.shareId) query.set("shareId", target.shareId);
      const { etag } = await call<{ etag: string }>(`/api/files/uploads/part?${query}`, { method: "PUT", body: chunk });
      parts.push({ part, etag });
      offset += chunk.size;
      part += 1;
      track({ id, name: file.name, sent: offset, total: file.size }, id);
    } while (offset < file.size);
    return await call<{ key: string; size: number }>("/api/files/uploads/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: started.key, uploadId: started.uploadId, parts, ...target }),
    });
  } catch (error) {
    if (started) {
      void call("/api/files/uploads/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: started.key, uploadId: started.uploadId, abort: true, ...target }),
      }).catch(() => undefined);
    }
    throw error instanceof Error ? error : new Error(t("No se pudo subir."));
  } finally {
    track(null, id);
  }
}

/** Los enlaces firmados duran una hora; se piden de nuevo pasados 50 minutos. */
const FRESH_MS = 50 * 60_000;
const links = new Map<string, { links: FileLinks | null; at: number }>();

/**
 * Por documento y versión del archivo (`key`): al guardarse (un dibujo, el
 * editor de Office) el archivo pasa a otro objeto y el anterior puede
 * borrarse, así que un enlace guardado de la versión vieja ya no sirve.
 */
async function ownLinks(docId: string, key: string | null): Promise<FileLinks | null> {
  const id = `${docId}:${key ?? ""}`;
  const cached = links.get(id);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.links;
  const fresh = await fileLink({ data: { docId } }).catch(() => null);
  // Solo se recuerda lo que salió bien: un archivo recién subido aún puede no estar en el servidor.
  if (fresh) links.set(id, { links: fresh, at: Date.now() });
  return fresh;
}

/** Reintentos si el servidor aún no conoce el archivo (recién subido, sincronizando). */
const LINK_RETRIES = 5;

/**
 * Enlaces de un archivo propio. Los archivos antiguos que aún traen el
 * contenido (`dataUrl`) se ven directamente. `retry` vuelve a pedirlos, por
 * ejemplo cuando el archivo recién subido aún no había llegado al servidor.
 */
export function useFileLinks(docId: string, file: VaultFile | null): { links: FileLinks | null; retry: () => void } {
  const [state, setState] = useState<FileLinks | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inline = !file?.key && file?.dataUrl ? file.dataUrl : null;
  const key = file?.key ?? null;

  const shownFor = useRef(docId);

  useEffect(() => setAttempt(0), [docId]);

  useEffect(() => {
    if (inline || !key) return;
    let cancelled = false;
    // Otro documento: sin enlaces hasta tener los suyos. El mismo con una
    // versión nueva (lo guardó un dibujo o el editor de Office): se siguen
    // mostrando los anteriores mientras llegan, sin desmontar la vista.
    if (shownFor.current !== docId) {
      shownFor.current = docId;
      setState(null);
    }
    let timer = 0;
    void ownLinks(docId, key).then((next) => {
      if (cancelled) return;
      setState(next);
      if (!next && attempt < LINK_RETRIES) timer = window.setTimeout(() => setAttempt((value) => value + 1), 1500);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [docId, key, inline, attempt]);

  return {
    links: inline ? { url: inline, downloadUrl: inline } : state,
    retry: () => {
      links.delete(`${docId}:${key ?? ""}`);
      setAttempt((value) => value + 1);
    },
  };
}

/** Descarga un archivo propio. */
export async function downloadFile(document: Document): Promise<void> {
  const file = document.file;
  if (!file) return;
  const href = file.key ? (await ownLinks(document.id, file.key))?.downloadUrl : file.dataUrl;
  if (!href) return;
  const link = window.document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.click();
}
