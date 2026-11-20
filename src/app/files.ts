import { uuid } from "@/lib/uuid";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Document, VaultFile } from "@/domain/vault/types";
import { bearerHeader } from "@/lib/auth/bearer";
import { readAnswer } from "@/lib/http-answer";
import { fileLink, viewerEvent, type ViewerStage } from "@/server/files.functions";
import { useVault } from "@/app/vault/store";
import { knownToServer, onSynced, syncVault } from "@/app/vault/sync";
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

/** A refused upload with the server's status: 415 blocked extension, 422 antivirus hit. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.headers as Record<string, string> | undefined), ...bearerHeader() },
  });
  const answer = await readAnswer<T>(response, init.signal);
  if (!answer.ok)
    throw new UploadError(
      answer.error || t("El servidor respondió {0}.", { 0: answer.status }),
      answer.status,
    );
  return answer.body;
}

/** The document a personal upload is stored in, sent with the last request; see uploads.complete. */
export type UploadDoc = {
  id: string;
  title: string;
  name: string;
  mime: string;
  createdAt: number;
  actor: string;
};

/**
 * Upload a file in parts, returning its key and size or throwing an explanatory Error. target
 * identifies the destination portfolio for quota accounting and an optional shareId. With
 * options.doc the server also stores the document that holds the file, and returns it.
 */
export async function uploadVaultFile(
  file: File,
  target: { portfolioId?: string | null; shareId?: string } = {},
  options: { signal?: AbortSignal; importId?: string; doc?: UploadDoc } = {},
): Promise<{ key: string; size: number; doc?: Document; revision?: number }> {
  const signal = options.signal;
  // Every request of one import carries its id, so the server's events can be followed.
  const headers: Record<string, string> = options.importId
    ? { "x-grafito-import": options.importId }
    : {};
  const id = uuid();
  const mime = file.type || "application/octet-stream";
  track({ id, name: file.name, sent: 0, total: file.size }, id);
  let started: { key: string; uploadId: string; partSize: number } | null = null;
  try {
    started = await call<{ key: string; uploadId: string; partSize: number }>(
      "/api/files/uploads",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ name: file.name, mime, size: file.size, ...target }),
        signal,
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
        headers,
        body: chunk,
        signal,
      });
      parts.push({ part, etag });
      offset += chunk.size;
      part += 1;
      track({ id, name: file.name, sent: offset, total: file.size }, id);
    } while (offset < file.size);
    return await call<{ key: string; size: number; doc?: Document; revision?: number }>(
      "/api/files/uploads/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          key: started.key,
          uploadId: started.uploadId,
          parts,
          ...target,
          ...(options.doc ? { doc: options.doc } : {}),
        }),
        // Not cut by a pause or a cancel: once the parts are sent, the server finishes the file
        // (scan, document) either way, and the answer says which, so nothing stored goes
        // unreported. Only the transfer above stops at once.
      },
    );
  } catch (error) {
    if (started) {
      void call("/api/files/uploads/complete", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          key: started.key,
          uploadId: started.uploadId,
          abort: true,
          ...target,
        }),
      }).catch((failure: unknown) => {
        // The unfinished upload expires in storage on its own.
        console.warn("[upload] an unfinished upload could not be cancelled", failure);
      });
    }
    throw error instanceof Error ? error : new Error(t("No se pudo subir."));
  } finally {
    track(null, id);
  }
}

/** Signed links last one hour; refresh after fifty minutes. */
const FRESH_MS = 50 * 60_000;
const links = new Map<string, { links: FileLinks; at: number }>();

/**
 * Why an owned file has no links yet. pending: the server does not have the document yet and
 * this browser still has to send it; missing: the server does not have it (deleted elsewhere,
 * or never stored); forbidden: the role may not read it; empty: the document holds no bytes;
 * failed: the request itself failed (connection, session).
 */
export type LinkState =
  | { state: "loading" }
  | { state: "ready"; links: FileLinks }
  | { state: "pending" | "missing" | "forbidden" | "empty" | "failed"; detail?: string };

type Fetched = Exclude<LinkState, { state: "loading" } | { state: "pending" }>;

/**
 * Cache by document and file key. Drawing or Office saves replace the object and may delete its
 * predecessor, invalidating links to the old version.
 */
async function ownLinks(docId: string, key: string | null): Promise<Fetched> {
  const id = `${docId}:${key ?? ""}`;
  const cached = links.get(id);
  if (cached && Date.now() - cached.at < FRESH_MS) return { state: "ready", links: cached.links };
  try {
    const fresh = await fileLink({ data: { docId } });
    if (!fresh.ok) return { state: fresh.reason };
    const value = { url: fresh.url, downloadUrl: fresh.downloadUrl };
    links.set(id, { links: value, at: Date.now() });
    return { state: "ready", links: value };
  } catch (error) {
    return { state: "failed", detail: error instanceof Error ? error.message : "" };
  }
}

/**
 * Links for an owned file. Legacy dataUrl files render directly. A document the server does not
 * have yet waits for this browser's next synchronization (no timers); retry asks again.
 */
export function useFileLinks(
  docId: string,
  file: VaultFile | null,
): { links: FileLinks | null; status: LinkState; retry: () => void } {
  const [status, setStatus] = useState<LinkState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const inline = !file?.key && file?.dataUrl ? file.dataUrl : null;
  const key = file?.key ?? null;

  const shownFor = useRef(docId);

  useEffect(() => {
    if (inline || !key) return;
    let cancelled = false;
    let stop = () => {};
    // Clear links when changing documents. For a new version of the same file, keep existing
    // links until replacements arrive to avoid unmounting the viewer.
    if (shownFor.current !== docId) {
      shownFor.current = docId;
      setStatus({ state: "loading" });
    }
    const started = performance.now();
    void ownLinks(docId, key).then((next) => {
      if (cancelled) return;
      const owner = useVault.getState().owner;
      if (next.state === "missing" && owner && !knownToServer(owner, docId)) {
        // Not sent yet: show that, and ask again once a synchronization went through.
        setStatus({ state: "pending" });
        stop = onSynced(() => setAttempt((value) => value + 1));
        void syncVault(owner);
        return;
      }
      setStatus(next);
      if (next.state !== "ready") reportViewer("link", next.state, performance.now() - started);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [docId, key, inline, attempt]);

  return {
    links: inline
      ? { url: inline, downloadUrl: inline }
      : status.state === "ready"
        ? status.links
        : null,
    status: inline ? { state: "ready", links: { url: inline, downloadUrl: inline } } : status,
    retry: () => {
      links.delete(`${docId}:${key ?? ""}`);
      setAttempt((value) => value + 1);
    },
  };
}

/**
 * A viewer could not show a file: log the kind of failure on the server (no names, no links).
 * Shared by the PDF and Office viewers.
 */
export function reportViewer(stage: ViewerStage, kind: string, ms: number): void {
  void viewerEvent({ data: { stage, kind: kind.slice(0, 40), ms: Math.round(ms) } }).catch(
    (error: unknown) => {
      console.warn("[viewer] the failure could not be reported", error);
    },
  );
}

/** Download an owned file. */
export async function downloadFile(document: Document): Promise<void> {
  const file = document.file;
  if (!file) return;
  const fetched = file.key ? await ownLinks(document.id, file.key) : null;
  const href = file.key
    ? fetched?.state === "ready"
      ? fetched.links.downloadUrl
      : null
    : file.dataUrl;
  if (!href) return;
  const link = window.document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.click();
}
