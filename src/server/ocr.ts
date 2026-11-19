import type { Sql } from "@/lib/db";
import { readBlob } from "./blobs";
import { claimJob } from "./jobs";

export { ocrCandidate } from "@/domain/vault/ocr";

/**
 * OCR for scanned PDFs and images (docker/ocr). When indexing finds a PDF without a text layer,
 * or an image, it queues the document here; a background pass sends it to the ocr service and
 * stores the text, and the document is indexed again with it. OCR_URL points at the service
 * (http://ocr:8080 in Docker); empty turns OCR off.
 */

const TICK_MS = 3000;
const LOCK = "ocr";
/** A scanned page that comes back with no letters is still a read page; below this, nothing. */
const MIN_TEXT = 1;

export function ocrUrl(): string | null {
  const raw = process.env.OCR_URL;
  if (raw === undefined) return process.env.GRAFITO_FROM_DOCKER === "1" ? "http://ocr:8080" : null;
  return raw.trim() || null;
}

/**
 * Text already recognized for this version of the file, or null; queues the document when it
 * has not been read yet (or its file changed). Called by the indexer when extraction found no
 * text.
 */
export async function ocrTextFor(
  sql: Sql,
  input: { ownerId: string; docId: string; fileKey: string },
): Promise<string | null> {
  if (!ocrUrl()) return null;
  const rows = await sql<{ file_key: string; state: string; text: string }>`
    select file_key, state, text from ocr_text
    where owner_id = ${input.ownerId} and doc_id = ${input.docId} limit 1
  `;
  const row = rows[0];
  if (row && row.file_key === input.fileKey) return row.state === "done" ? row.text : null;
  await sql`
    insert into ocr_text (owner_id, doc_id, file_key, state, updated_at)
    values (${input.ownerId}, ${input.docId}, ${input.fileKey}, 'pending', ${Date.now()})
    on conflict (owner_id, doc_id) do update set
      file_key = excluded.file_key, state = 'pending', text = '', error = '', pages = 0,
      updated_at = excluded.updated_at
  `;
  return null;
}

async function recognize(bytes: Uint8Array): Promise<{ pages: string[] } | { error: string }> {
  const url = ocrUrl();
  if (!url) return { error: "OCR apagado." };
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/ocr?lang=spa+eng`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(20 * 60_000),
    });
    const body = (await response.json().catch(() => ({}))) as { pages?: string[]; error?: string };
    if (!response.ok || !Array.isArray(body.pages))
      return { error: body.error || `El OCR respondió ${response.status}.` };
    return { pages: body.pages };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "El OCR no está disponible." };
  }
}

/** Read the oldest queued document, store its text and have it indexed again. */
export async function ocrStep(sql: Sql): Promise<boolean> {
  const rows = await sql<{ owner_id: string; doc_id: string; file_key: string }>`
    select owner_id, doc_id, file_key from ocr_text
    where state = 'pending' order by updated_at asc limit 1
  `;
  const job = rows[0];
  if (!job) return false;
  const bytes = await readBlob(sql, job.file_key);
  const result = bytes ? await recognize(bytes) : { error: "El archivo ya no está." };
  const now = Date.now();
  if ("pages" in result) {
    const text = result.pages.join("\n\n").trim();
    await sql`
      update ocr_text set state = ${text.length >= MIN_TEXT ? "done" : "empty"}, text = ${text},
        pages = ${result.pages.length}, error = '', updated_at = ${now}
      where owner_id = ${job.owner_id} and doc_id = ${job.doc_id} and file_key = ${job.file_key}
    `;
  } else {
    await sql`
      update ocr_text set state = 'failed', error = ${result.error.slice(0, 300)}, updated_at = ${now}
      where owner_id = ${job.owner_id} and doc_id = ${job.doc_id} and file_key = ${job.file_key}
    `;
  }
  // The indexer takes the document again and finds the recognized text.
  await sql`delete from content_index where user_id = ${job.owner_id} and doc_id = ${job.doc_id}`;
  return true;
}

export type OcrStatus = { pending: number; done: number; failed: number; enabled: boolean };

export async function readOcrStatus(sql: Sql): Promise<OcrStatus> {
  const rows = await sql<{ state: string; n: number }>`
    select state, count(*)::int as n from ocr_text group by state
  `;
  const count = (state: string) => rows.find((row) => row.state === state)?.n ?? 0;
  return {
    pending: count("pending"),
    done: count("done") + count("empty"),
    failed: count("failed"),
    enabled: Boolean(ocrUrl()),
  };
}

const globalRef = globalThis as typeof globalThis & {
  __grafitoOcr__?: ReturnType<typeof setInterval>;
};
let busy = false;

/** Start the OCR loop once per process; one replica reads at a time. */
export function startOcr(): void {
  if (globalRef.__grafitoOcr__ || !ocrUrl()) return;
  globalRef.__grafitoOcr__ = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        // A long scan can take minutes: hold the claim long enough, give it back after.
        if (!(await claimJob(sql, LOCK, 25 * 60_000))) return;
        try {
          await ocrStep(sql);
        } finally {
          await sql`update app_setting set value = '0' where key = ${`job:${LOCK}`}`;
        }
      } catch (error) {
        console.error("[ocr]", error);
      } finally {
        busy = false;
      }
    })();
  }, TICK_MS);
  globalRef.__grafitoOcr__.unref?.();
}
