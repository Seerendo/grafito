import type { Document, Portfolio } from "./types.ts";

/** Changes the browser sends to the server in one push; see app/vault/sync.ts. */
export type VaultChangeSet = {
  docs: Document[];
  deletedDocs: string[];
  portfolios: Portfolio[];
  deletedPortfolios: string[];
};

/** At most this many documents, or this many bytes of them, per push. */
export const PUSH_DOCS = 100;
export const PUSH_BYTES = 2_000_000;
/** Folders and deletions per push; the server accepts up to 2000 of each. */
export const PUSH_FOLDERS = 500;
export const PUSH_DELETES = 1000;

function empty(): VaultChangeSet {
  return { docs: [], deletedDocs: [], portfolios: [], deletedPortfolios: [] };
}

function size(changes: VaultChangeSet): number {
  return (
    changes.docs.length +
    changes.deletedDocs.length +
    changes.portfolios.length +
    changes.deletedPortfolios.length
  );
}

/**
 * Split changes into pushes the server accepts and that stay small: folders first (a document's
 * folder is on the server before it), then documents, then deleted folders before deleted
 * documents, so what was deleted with a folder has a deletion time no earlier than the
 * folder's (see restorePortfolio). Order inside each list is kept.
 */
export function pushBatches(changes: VaultChangeSet): VaultChangeSet[] {
  const out: VaultChangeSet[] = [];
  let current = empty();
  let bytes = 0;
  let deletes = 0;
  const flush = () => {
    out.push(current);
    current = empty();
    bytes = 0;
    deletes = 0;
  };
  for (const portfolio of changes.portfolios) {
    if (current.portfolios.length >= PUSH_FOLDERS) flush();
    current.portfolios.push(portfolio);
  }
  for (const doc of changes.docs) {
    const weight = doc.content.length + (doc.base?.content.length ?? 0) + 500;
    if (
      current.docs.length >= PUSH_DOCS ||
      (current.docs.length > 0 && bytes + weight > PUSH_BYTES)
    )
      flush();
    current.docs.push(doc);
    bytes += weight;
  }
  for (const id of changes.deletedPortfolios) {
    if (deletes >= PUSH_DELETES) flush();
    current.deletedPortfolios.push(id);
    deletes += 1;
  }
  for (const id of changes.deletedDocs) {
    if (deletes >= PUSH_DELETES) flush();
    current.deletedDocs.push(id);
    deletes += 1;
  }
  if (size(current) > 0) flush();
  return out;
}
