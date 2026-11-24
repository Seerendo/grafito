import { pushBatches, type VaultChangeSet as Changes } from "@/domain/vault/sync-batches";
import type { Document, Portfolio } from "@/domain/vault/types";
import { pullVault, pushVault } from "@/server/vault.functions";
import {
  confirmDeletes,
  dropDeletes,
  markDeletesFailed,
  onPendingDeletes,
  pendingDeletes,
} from "./pending-deletes";
import { isBlankDraft, useVault } from "./store";

/**
 * Synchronize the browser cache with the authoritative server vault used by API and AI. Track
 * each user's revision and synchronized fingerprints. First pull newer changes, preserving
 * local edits. Notes carry a base for server-side merging; files and legacy caches use
 * newest-wins. Then push local changes, in bounded batches. Unmergeable note conflicts stop
 * uploading until keepTheirs or keepMine resolves them. New browsers replace sample data with
 * the server vault; existing legacy local vaults merge and upload missing content.
 *
 * Deletions are only the ones recorded when the person deleted something (pending-deletes.ts).
 * Something the server has that is missing from the local cache is fetched again, never
 * deleted: a cache the browser could not save in full must not empty the server.
 */

type Meta = { rev: number; docs: Record<string, string>; portfolios: Record<string, string> };

const META_PREFIX = "grafito.sync:";

function docSignature(doc: Document): string {
  return [
    doc.updatedAt,
    doc.title,
    doc.portfolioId ?? "",
    doc.pinned ? 1 : 0,
    JSON.stringify(doc.links),
    doc.content.length,
    doc.file?.key ?? doc.file?.dataUrl?.length ?? 0,
  ].join("|");
}

function portfolioSignature(portfolio: Portfolio): string {
  return `${portfolio.name}|${portfolio.parentId ?? ""}|${JSON.stringify(portfolio.links ?? [])}`;
}

/** One live copy per user: every writer changes it in place, so none overwrites another. */
const metas = new Map<string, Meta>();

function readMeta(userId: string): Meta | null {
  const held = metas.get(userId);
  if (held) return held;
  try {
    const raw = localStorage.getItem(META_PREFIX + userId);
    const meta = raw ? (JSON.parse(raw) as Meta) : null;
    if (meta) metas.set(userId, meta);
    return meta;
  } catch {
    return null;
  }
}

function writeMeta(userId: string, meta: Meta): void {
  metas.set(userId, meta);
  try {
    localStorage.setItem(META_PREFIX + userId, JSON.stringify(meta));
  } catch (error) {
    // Kept in memory for this tab. After a reload the older copy only makes the browser send
    // some documents again; the server keeps the newest of each.
    console.warn("[vault] synchronization state could not be saved", error);
  }
}

function snapshot(
  documents: Document[],
  portfolios: Portfolio[],
): Pick<Meta, "docs" | "portfolios"> {
  return {
    docs: Object.fromEntries(documents.map((doc) => [doc.id, docSignature(doc)])),
    portfolios: Object.fromEntries(
      portfolios.map((portfolio) => [portfolio.id, portfolioSignature(portfolio)]),
    ),
  };
}

/**
 * The server stored these itself (a background upload): they are synchronized as they are, so
 * the next push does not send them again.
 */
export function markKnown(
  userId: string,
  items: { docs?: Document[]; portfolios?: Portfolio[] },
): void {
  const meta = readMeta(userId);
  if (!meta) return;
  for (const doc of items.docs ?? []) meta.docs[doc.id] = docSignature(doc);
  for (const portfolio of items.portfolios ?? [])
    meta.portfolios[portfolio.id] = portfolioSignature(portfolio);
  writeMeta(userId, meta);
}

/** Whether the server has this document, as far as this browser knows. */
export function knownToServer(userId: string, docId: string): boolean {
  return readMeta(userId)?.docs[docId] !== undefined;
}

/** Whether the server has this portfolio, as far as this browser knows. */
export function knownFolderToServer(userId: string, portfolioId: string): boolean {
  return readMeta(userId)?.portfolios[portfolioId] !== undefined;
}

let running: Promise<void> | null = null;
let again = false;

export type SyncStatus = "idle" | "syncing" | "error" | "offline";
let status: SyncStatus = "idle";
const listeners = new Set<(status: SyncStatus) => void>();

/** What one finished synchronization did, for views that follow the server. */
export type SyncResult = {
  pulled: number;
  pushed: number;
  deleted: number;
  ms: number;
};

const syncedListeners = new Set<(result: SyncResult) => void>();

/** Totals of this tab, read by the upload queue for its report. */
export const syncTotals = { runs: 0, ms: 0, pending: 0 };

function setStatus(next: SyncStatus): void {
  status = next;
  listeners.forEach((listener) => listener(next));
}

export function syncStatus(): SyncStatus {
  return status;
}

export function onSyncStatus(listener: (status: SyncStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called after each synchronization that finished without error. */
export function onSynced(listener: (result: SyncResult) => void): () => void {
  syncedListeners.add(listener);
  return () => syncedListeners.delete(listener);
}

/** Synchronize now; queue another pass if one is already running. */
export function syncVault(userId: string): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const started = performance.now();
        const result = await syncOnce(userId);
        const ms = Math.round(performance.now() - started);
        syncTotals.runs += 1;
        syncTotals.ms += ms;
        if (result) {
          markDeletesFailed(userId, false);
          for (const listener of syncedListeners) listener({ ...result, ms });
        }
      } while (again);
      setStatus("idle");
    } catch (error) {
      if (Object.keys(pendingDeletes(userId).docs).length > 0) markDeletesFailed(userId, true);
      console.warn(
        "[vault] synchronization failed",
        error instanceof Error ? error.message : error,
      );
      setStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce(userId: string): Promise<Omit<SyncResult, "ms"> | null> {
  const store = useVault.getState();
  if (store.owner !== userId || !store.hydrated) return null;
  setStatus("syncing");
  // A vault seeded with the sample in this browser is not the person's work: read the whole
  // server vault and adopt it, and only push the sample to a server that has nothing yet.
  let meta = store.seeded ? null : readMeta(userId);
  const pending = pendingDeletes(userId);
  // Known to the server but missing here, without having been deleted here: the local cache
  // is incomplete. Read everything again instead of pushing deletions.
  const localDocIds = new Set(store.documents.map((doc) => doc.id));
  const localFolderIds = new Set(store.portfolios.map((portfolio) => portfolio.id));
  const incomplete =
    meta !== null &&
    (Object.keys(meta.docs).some((id) => !localDocIds.has(id) && !(id in pending.docs)) ||
      Object.keys(meta.portfolios).some(
        (id) => !localFolderIds.has(id) && !(id in pending.portfolios),
      ));
  const since = incomplete ? 0 : (meta?.rev ?? 0);
  const pulled = await pullVault({ data: { since } });
  if (useVault.getState().owner !== userId) return null;
  const deletedHere = pendingDeletes(userId);
  const notDeletedHere = <T extends { id: string }>(items: T[], gone: Record<string, number>) =>
    items.filter((item) => !(item.id in gone));

  if (!meta) {
    if (pulled.revision > 0 && useVault.getState().seeded) {
      // New browsers adopt the server vault.
      const docs = notDeletedHere(pulled.docs, deletedHere.docs);
      const portfolios = notDeletedHere(pulled.portfolios, deletedHere.portfolios);
      useVault.getState().replaceVault(docs, portfolios);
      writeMeta(userId, { rev: pulled.revision, ...snapshot(pulled.docs, pulled.portfolios) });
      return { pulled: docs.length + portfolios.length, pushed: 0, deleted: 0 };
    }
    meta = { rev: 0, docs: {}, portfolios: {} };
    writeMeta(userId, meta);
  }

  // Apply incoming changes unless newer local edits exist.
  const local = useVault.getState();
  const localDocs = new Map(local.documents.map((doc) => [doc.id, doc]));
  const docs = notDeletedHere(pulled.docs, deletedHere.docs).filter((remote) => {
    const mine = localDocs.get(remote.id);
    if (!mine) return true;
    if (local.conflicts[remote.id]) {
      // For unresolved conflicts, offer the latest server version.
      useVault.getState().setConflict(remote);
      return false;
    }
    const changedHere = docSignature(mine) !== meta!.docs[remote.id];
    if (!changedHere) return true;
    if (mine.kind === "markdown" && mine.base) return false;
    return mine.updatedAt <= remote.updatedAt;
  });
  const deletedDocs = pulled.deletedDocs.filter((id) => {
    const mine = localDocs.get(id);
    return !mine || docSignature(mine) === meta!.docs[id];
  });
  const portfolios = notDeletedHere(pulled.portfolios, deletedHere.portfolios);
  const deletedPortfolios = pulled.deletedPortfolios;
  if (docs.length + deletedDocs.length + portfolios.length + deletedPortfolios.length > 0) {
    useVault.getState().applyRemote({ docs, deletedDocs, portfolios, deletedPortfolios });
  }
  for (const doc of docs) meta.docs[doc.id] = docSignature(doc);
  for (const id of deletedDocs) delete meta.docs[id];
  for (const portfolio of portfolios) meta.portfolios[portfolio.id] = portfolioSignature(portfolio);
  for (const id of deletedPortfolios) delete meta.portfolios[id];
  // Already deleted on the server (by another session, or a deletion sent before a reload).
  dropDeletes(
    userId,
    pulled.deletedDocs.filter((id) => !(id in meta!.docs)),
    deletedPortfolios,
  );
  if (incomplete) {
    // A full read returns every row the server ever had; anything else is gone for good.
    const present = new Set([...pulled.docs.map((doc) => doc.id), ...pulled.deletedDocs]);
    for (const id of Object.keys(meta.docs)) if (!present.has(id)) delete meta.docs[id];
    const folders = new Set([
      ...pulled.portfolios.map((portfolio) => portfolio.id),
      ...pulled.deletedPortfolios,
    ]);
    for (const id of Object.keys(meta.portfolios)) if (!folders.has(id)) delete meta.portfolios[id];
    console.warn("[vault] local copy was incomplete; read again from the server");
  }
  meta.rev = pulled.revision;
  writeMeta(userId, meta);
  const pulledCount =
    docs.length + deletedDocs.length + portfolios.length + deletedPortfolios.length;

  // Upload local changes.
  const now = useVault.getState();
  const nowDocIds = new Set(now.documents.map((doc) => doc.id));
  const nowFolderIds = new Set(now.portfolios.map((portfolio) => portfolio.id));
  const toDelete = pendingDeletes(userId);
  // A pending deletion of something that is here again (restored meanwhile) is void.
  dropDeletes(
    userId,
    Object.keys(toDelete.docs).filter((id) => nowDocIds.has(id)),
    Object.keys(toDelete.portfolios).filter((id) => nowFolderIds.has(id)),
  );
  const deletions = pendingDeletes(userId);
  const changes: Changes = {
    // Do not upload untouched blank drafts; they are discarded when left.
    docs: now.documents.filter(
      (doc) =>
        meta!.docs[doc.id] !== docSignature(doc) &&
        !isBlankDraft(now.draft, doc) &&
        !now.conflicts[doc.id],
    ),
    deletedDocs: Object.keys(deletions.docs),
    portfolios: now.portfolios.filter(
      (portfolio) => meta!.portfolios[portfolio.id] !== portfolioSignature(portfolio),
    ),
    deletedPortfolios: Object.keys(deletions.portfolios),
  };
  const total =
    changes.docs.length +
    changes.deletedDocs.length +
    changes.portfolios.length +
    changes.deletedPortfolios.length;
  syncTotals.pending = total;
  if (total === 0) return { pulled: pulledCount, pushed: 0, deleted: 0 };
  let restoring = now.restoreSample;
  let pushed = 0;
  let deleted = 0;
  let contiguous = true;
  for (const batch of pushBatches(changes)) {
    const ages = [
      ...batch.deletedDocs.map((id) => deletions.docs[id] ?? Date.now()),
      ...batch.deletedPortfolios.map((id) => deletions.portfolios[id] ?? Date.now()),
    ];
    const result = await pushVault({
      data: {
        ...batch,
        restoreSamples: restoring,
        ...(ages.length > 0 ? { deleteAgeMs: Math.max(0, Date.now() - Math.min(...ages)) } : {}),
      },
    });
    if (!result.ok) {
      // Without write permission, the next refresh restores authoritative server content.
      if (batch.deletedDocs.length + batch.deletedPortfolios.length > 0)
        markDeletesFailed(userId, true);
      console.warn("[vault] the server refused changes", result.error);
      break;
    }
    if (restoring) {
      useVault.setState({ restoreSample: false });
      restoring = false;
    }
    // Deleted sample documentation the server would not take back: drop it here too.
    if (result.dropped.docs.length + result.dropped.portfolios.length > 0) {
      useVault.getState().applyRemote({
        docs: [],
        deletedDocs: result.dropped.docs,
        portfolios: [],
        deletedPortfolios: result.dropped.portfolios,
      });
      again = true;
    }
    const refused = new Set(result.conflicts.map((doc) => doc.id));
    const dropped = new Set([...result.dropped.docs, ...result.dropped.portfolios]);
    useVault.getState().markSynced(batch.docs.filter((doc) => !refused.has(doc.id)));
    for (const theirs of result.conflicts) useVault.getState().setConflict(theirs);
    // Conflicted notes still count as locally changed.
    for (const doc of batch.docs)
      if (!refused.has(doc.id) && !dropped.has(doc.id)) meta.docs[doc.id] = docSignature(doc);
    for (const portfolio of batch.portfolios)
      if (!dropped.has(portfolio.id)) meta.portfolios[portfolio.id] = portfolioSignature(portfolio);
    for (const id of batch.deletedDocs) delete meta.docs[id];
    for (const id of batch.deletedPortfolios) delete meta.portfolios[id];
    confirmDeletes(userId, { docs: batch.deletedDocs, portfolios: batch.deletedPortfolios });
    pushed += batch.docs.length + batch.portfolios.length;
    deleted += batch.deletedDocs.length + batch.deletedPortfolios.length;
    // If another client, MCP or the API advanced the revision by more than one, retain the old revision
    // so the next pull includes those changes. Also pull server-merged note versions.
    if (contiguous && result.revision === meta.rev + 1 && result.merged.length === 0)
      meta.rev = result.revision;
    else contiguous = false;
    writeMeta(userId, meta);
  }
  if (!contiguous) again = true;
  syncTotals.pending = Math.max(0, total - pushed - deleted);
  return { pulled: pulledCount, pushed, deleted };
}

/** Resolve a note conflict by keeping the server version. */
export function keepTheirs(userId: string, id: string): void {
  const store = useVault.getState();
  const theirs = store.conflicts[id];
  if (!theirs) return;
  store.clearConflict(id);
  store.applyRemote({ docs: [theirs], deletedDocs: [], portfolios: [], deletedPortfolios: [] });
  const meta = readMeta(userId);
  if (meta) {
    meta.docs[id] = docSignature(theirs);
    writeMeta(userId, meta);
  }
}

/**
 * Resolve a conflict by keeping the local version against the latest server base; the next
 * upload replaces it while history preserves the prior version.
 */
export function keepMine(userId: string, id: string): void {
  const store = useVault.getState();
  const theirs = store.conflicts[id];
  if (!theirs) return;
  store.clearConflict(id);
  useVault.setState((state) => ({
    documents: state.documents.map((doc) =>
      doc.id === id
        ? {
            ...doc,
            base: { content: theirs.content, title: theirs.title, updatedAt: theirs.updatedAt },
          }
        : doc,
    ),
  }));
  void syncVault(userId);
}

/** Forget synchronization metadata, for example after clearing the local cache. */
export function forgetSync(userId: string): void {
  metas.delete(userId);
  try {
    localStorage.removeItem(META_PREFIX + userId);
  } catch {
    /* Nothing to remove. */
  }
}

/**
 * Synchronize on opening, shortly after local edits, at once after a deletion, every twenty
 * seconds and when returning to the tab.
 */
export function startVaultSync(userId: string): () => void {
  let debounce = 0;
  void syncVault(userId);
  const unsubscribe = useVault.subscribe((state, previous) => {
    if (state.owner !== userId) return;
    if (state.documents === previous.documents && state.portfolios === previous.portfolios) return;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void syncVault(userId), 1500);
  });
  const interval = window.setInterval(() => {
    if (document.visibilityState === "visible") void syncVault(userId);
  }, 20_000);
  const onVisible = () => {
    if (document.visibilityState === "visible") void syncVault(userId);
  };
  // A deletion goes to the server at once, so it reaches the trash without the edit delay. Not
  // again after a failed attempt: the next regular synchronization retries it.
  const stopDeletes = onPendingDeletes(() => {
    const pending = pendingDeletes(userId);
    const count = Object.keys(pending.docs).length + Object.keys(pending.portfolios).length;
    if (count > 0 && !pending.failed) void syncVault(userId);
  });
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  return () => {
    window.clearTimeout(debounce);
    window.clearInterval(interval);
    unsubscribe();
    stopDeletes();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onVisible);
  };
}
