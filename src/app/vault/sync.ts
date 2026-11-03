import type { Document, Portfolio } from "@/domain/vault/types";
import { pullVault, pushVault } from "@/server/vault.functions";
import { isBlankDraft, useVault } from "./store";

/**
 * Synchronize the browser cache with the authoritative server vault used by API and AI. Track
 * each user's revision and synchronized fingerprints. First pull newer changes, preserving
 * local edits. Notes carry a base for server-side merging; files and legacy caches use
 * newest-wins. Then push local changes. Unmergeable note conflicts stop uploading until
 * keepTheirs or keepMine resolves them. New browsers replace sample data with the server vault;
 * existing legacy local vaults merge and upload missing content.
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

function readMeta(userId: string): Meta | null {
  try {
    const raw = localStorage.getItem(META_PREFIX + userId);
    return raw ? (JSON.parse(raw) as Meta) : null;
  } catch {
    return null;
  }
}

function writeMeta(userId: string, meta: Meta): void {
  try {
    localStorage.setItem(META_PREFIX + userId, JSON.stringify(meta));
  } catch {
    /* Storage full; retry on the next synchronization. */
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

let running: Promise<void> | null = null;
let again = false;

export type SyncStatus = "idle" | "syncing" | "error" | "offline";
let status: SyncStatus = "idle";
const listeners = new Set<(status: SyncStatus) => void>();

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
        await syncOnce(userId);
      } while (again);
      setStatus("idle");
    } catch {
      setStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce(userId: string): Promise<void> {
  const store = useVault.getState();
  if (store.owner !== userId || !store.hydrated) return;
  setStatus("syncing");
  let meta = readMeta(userId);
  const pulled = await pullVault({ data: { since: meta?.rev ?? 0 } });
  if (useVault.getState().owner !== userId) return;

  if (!meta) {
    if (pulled.revision > 0 && useVault.getState().seeded) {
      // New browsers adopt the server vault.
      useVault.getState().replaceVault(pulled.docs, pulled.portfolios);
      writeMeta(userId, { rev: pulled.revision, ...snapshot(pulled.docs, pulled.portfolios) });
      return;
    }
    meta = { rev: 0, docs: {}, portfolios: {} };
  }

  // Apply incoming changes unless newer local edits exist.
  const local = useVault.getState();
  const localDocs = new Map(local.documents.map((doc) => [doc.id, doc]));
  const docs = pulled.docs.filter((remote) => {
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
  const portfolios = pulled.portfolios;
  const deletedPortfolios = pulled.deletedPortfolios;
  if (docs.length + deletedDocs.length + portfolios.length + deletedPortfolios.length > 0) {
    useVault.getState().applyRemote({ docs, deletedDocs, portfolios, deletedPortfolios });
  }
  for (const doc of docs) meta.docs[doc.id] = docSignature(doc);
  for (const id of deletedDocs) delete meta.docs[id];
  for (const portfolio of portfolios) meta.portfolios[portfolio.id] = portfolioSignature(portfolio);
  for (const id of deletedPortfolios) delete meta.portfolios[id];
  meta.rev = pulled.revision;
  writeMeta(userId, meta);

  // Upload local changes.
  const now = useVault.getState();
  const changes = {
    // Do not upload untouched blank drafts; they are discarded when left.
    docs: now.documents.filter(
      (doc) =>
        meta!.docs[doc.id] !== docSignature(doc) &&
        !isBlankDraft(now.draft, doc) &&
        !now.conflicts[doc.id],
    ),
    deletedDocs: Object.keys(meta.docs).filter((id) => !now.documents.some((doc) => doc.id === id)),
    portfolios: now.portfolios.filter(
      (portfolio) => meta!.portfolios[portfolio.id] !== portfolioSignature(portfolio),
    ),
    deletedPortfolios: Object.keys(meta.portfolios).filter(
      (id) => !now.portfolios.some((portfolio) => portfolio.id === id),
    ),
  };
  const total =
    changes.docs.length +
    changes.deletedDocs.length +
    changes.portfolios.length +
    changes.deletedPortfolios.length;
  if (total === 0) return;
  const result = await pushVault({ data: changes });
  if (!result.ok) {
    // Without write permission, the next refresh restores authoritative server content.
    return;
  }
  const refused = new Set(result.conflicts.map((doc) => doc.id));
  useVault.getState().markSynced(changes.docs.filter((doc) => !refused.has(doc.id)));
  for (const theirs of result.conflicts) useVault.getState().setConflict(theirs);
  const after = snapshot(now.documents, now.portfolios);
  // Conflicted notes still count as locally changed.
  for (const id of refused) {
    if (meta.docs[id] === undefined) delete after.docs[id];
    else after.docs[id] = meta.docs[id];
  }
  // If another client or AI advanced the revision by more than one, retain the old revision so the next pull includes those changes. Also pull server-merged note versions.
  const rev =
    result.revision === meta.rev + 1 && result.merged.length === 0 ? result.revision : meta.rev;
  writeMeta(userId, { rev, ...after });
  if (rev !== result.revision) again = true;
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
  try {
    localStorage.removeItem(META_PREFIX + userId);
  } catch {
    /* Nothing to remove. */
  }
}

/**
 * Synchronize on opening, shortly after local edits, every twenty seconds and when returning to
 * the tab.
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
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onVisible);
  return () => {
    window.clearTimeout(debounce);
    window.clearInterval(interval);
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onVisible);
  };
}
