import { uuid } from "@/lib/uuid";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Document, VaultFile } from "@/domain/vault/types";
import { bearerHeader } from "@/lib/auth/bearer";
import { fileLink } from "@/server/files.functions";
import { t } from "@/app/i18n";

/**
 * Client files: multipart uploads to /api/files/uploads, signed view/download links and upload
 * progress.
 */

export type FileLinks = { url: string; downloadUrl: string | null };

type Upload = { id: string; name: string; sent: number; total: number };

export const useUploads = create<{ uploads: Upload[] }>(() => ({ uploads: [] }));

function track(upload: Upload | null, id: string): void {
  useUploads.setState((state) => ({
    uploads: upload
      ? [...state.uploads.filter((item) => item.id !== id), upload]
      : state.uploads.filter((item) => item.id !== id),
  }));
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.headers as Record<string, string> | undefined), ...bearerHeader() },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error || t("El servidor respondió {0}.", { 0: response.status }));
  return body;
}

/**
 * Upload a file in parts, returning its key and size or throwing an explanatory Error. target
 * identifies the destination portfolio for quota accounting and an optional shareId.
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
    started = await call<{ key: string; uploadId: string; partSize: number }>(
      "/api/files/uploads",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: file.name, mime, size: file.size, ...target }),
      },
    );
    const parts: { part: number; etag: string }[] = [];
    let offset = 0;
    let part = 1;
    do {
      const chunk = file.slice(offset, offset + started.partSize);
      const query = new URLSearchParams({
        key: started.key,
        uploadId: started.uploadId,
        part: String(part),
      });
      if (target.shareId) query.set("shareId", target.shareId);
      const { etag } = await call<{ etag: string }>(`/api/files/uploads/part?${query}`, {
        method: "PUT",
        body: chunk,
      });
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
        body: JSON.stringify({
          key: started.key,
          uploadId: started.uploadId,
          abort: true,
          ...target,
        }),
      }).catch(() => undefined);
    }
    throw error instanceof Error ? error : new Error(t("No se pudo subir."));
  } finally {
    track(null, id);
  }
}

/** Signed links last one hour; refresh after fifty minutes. */
const FRESH_MS = 50 * 60_000;
const links = new Map<string, { links: FileLinks | null; at: number }>();

/**
 * Cache by document and file key. Drawing or Office saves replace the object and may delete its
 * predecessor, invalidating links to the old version.
 */
async function ownLinks(docId: string, key: string | null): Promise<FileLinks | null> {
  const id = `${docId}:${key ?? ""}`;
  const cached = links.get(id);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.links;
  const fresh = await fileLink({ data: { docId } }).catch(() => null);
  // Cache only successful results; newly uploaded files may not yet be known to the server.
  if (fresh) links.set(id, { links: fresh, at: Date.now() });
  return fresh;
}

/** Retry while a newly uploaded file is still synchronizing to the server. */
const LINK_RETRIES = 5;

/**
 * Links for an owned file. Legacy dataUrl files render directly. retry requests links again if
 * an upload had not yet reached the server.
 */
export function useFileLinks(
  docId: string,
  file: VaultFile | null,
): { links: FileLinks | null; retry: () => void } {
  const [state, setState] = useState<FileLinks | null>(null);
  const [attempt, setAttempt] = useState(0);
  const inline = !file?.key && file?.dataUrl ? file.dataUrl : null;
  const key = file?.key ?? null;

  const shownFor = useRef(docId);

  useEffect(() => setAttempt(0), [docId]);

  useEffect(() => {
    if (inline || !key) return;
    let cancelled = false;
    // Clear links when changing documents. For a new version of the same file, keep existing links until replacements arrive to avoid unmounting the viewer.
    if (shownFor.current !== docId) {
      shownFor.current = docId;
      setState(null);
    }
    let timer = 0;
    void ownLinks(docId, key).then((next) => {
      if (cancelled) return;
      setState(next);
      if (!next && attempt < LINK_RETRIES)
        timer = window.setTimeout(() => setAttempt((value) => value + 1), 1500);
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

/** Download an owned file. */
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
