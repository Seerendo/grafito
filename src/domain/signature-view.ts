/**
 * Client view of a PDF's signature requests. The server's signatureState is the only source;
 * this module turns each answer into one of four states the viewer shows (loading, error,
 * denied, ready) and builds the rectangles drawn over PDF.js pages.
 */

export type SignatureViewRow = {
  id: string;
  signerName: string;
  status: string;
  requestedByName: string;
  requestedAt: number;
  decidedAt: number | null;
  note: string;
  stale: boolean;
  mine: boolean;
  page: number | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
};

export type SignatureLoad = {
  /** ready also covers a document without signatures (rows is empty). */
  status: "loading" | "ready" | "error" | "denied";
  rows: SignatureViewRow[];
  canRequest: boolean;
};

export type SignatureAnswer =
  | { ok: true; canRequest: boolean; rows: SignatureViewRow[] }
  | { ok: false; canRequest: boolean; rows: unknown[] };

export const SIGNATURES_LOADING: SignatureLoad = { status: "loading", rows: [], canRequest: false };

/** Cache key for one document as seen through one share (or the caller's own vault). */
export function signatureKey(docId: string, shareId?: string | null): string {
  return `${shareId ?? ""}:${docId}`;
}

/** A server answer: rows when allowed, nothing (and no editing) when access is refused. */
export function settleSignatures(answer: SignatureAnswer): SignatureLoad {
  if (!answer.ok) return { status: "denied", rows: [], canRequest: false };
  return { status: "ready", rows: answer.rows, canRequest: answer.canRequest };
}

/**
 * A failed request (network, session, server). Rectangles already shown stay visible so a
 * transient failure during a refresh does not hide where to sign.
 */
export function failSignatures(previous: SignatureLoad | undefined): SignatureLoad {
  return { status: "error", rows: previous?.rows ?? [], canRequest: previous?.canRequest ?? false };
}

export type SignatureBoxView = {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  signerName: string;
  status: string;
  mine: boolean;
  stale: boolean;
};

/**
 * Rectangles to draw: rows with a whole page number and a box inside the page (fractions of the
 * displayed page, top-left origin). Coordinates are clamped to the page so a stored rounding
 * error cannot push a box out of view.
 */
export function signatureBoxes(rows: SignatureViewRow[]): SignatureBoxView[] {
  const out: SignatureBoxView[] = [];
  for (const row of rows) {
    const { page, x, y, w, h } = row;
    if (page == null || x == null || y == null || w == null || h == null) continue;
    if (!Number.isInteger(page) || page < 1) continue;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const left = Math.min(Math.max(x, 0), 1);
    const top = Math.min(Math.max(y, 0), 1);
    const width = Math.min(w, 1 - left);
    const height = Math.min(h, 1 - top);
    if (width <= 0 || height <= 0) continue;
    out.push({
      id: row.id,
      page,
      x: left,
      y: top,
      w: width,
      h: height,
      signerName: row.signerName,
      status: row.status,
      mine: row.mine,
      stale: row.stale,
    });
  }
  return out;
}

/** Signed request ids, to notice a stamp made elsewhere and reload the PDF. */
export function signedMark(rows: SignatureViewRow[]): string {
  return rows
    .filter((row) => row.status === "signed")
    .map((row) => row.id)
    .sort()
    .join(",");
}
