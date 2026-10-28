import type { Document, Portfolio } from "@/domain/vault/types";
import { pullVault, pushVault } from "@/server/vault.functions";
import { isBlankDraft, useVault } from "./store";

/**
 * Sincronización de la bóveda del navegador con la del servidor.
 *
 * El servidor es la fuente de verdad (lo usan también la API y la IA); el
 * navegador guarda una copia para abrir al instante y trabajar sin esperar.
 * Por cada usuario se recuerda la última revisión recibida y una huella de
 * cada documento y portafolio tal como quedó sincronizado: lo que difiere de
 * esa huella es un cambio local que hay que subir.
 *
 *  1. Baja los cambios posteriores a la revisión conocida y los aplica, salvo
 *     que el documento también cambiara aquí. Una nota cambiada aquí lleva la
 *     versión de la que partió (`base`) y la junta el servidor al subirla; los
 *     archivos y las cachés antiguas sin `base` siguen con «gana el más reciente».
 *  2. Sube lo que cambió aquí. Si otra persona cambió lo mismo de una nota, el
 *     servidor no la escribe y la nota queda en `conflicts` hasta que se elige
 *     cuál queda (`keepTheirs` / `keepMine`); mientras, no se sube.
 *
 * La primera vez en un navegador: si el servidor ya tiene la bóveda y aquí solo
 * hay la de ejemplo, se adopta la del servidor; si aquí había una bóveda
 * guardada (versiones anteriores), se mezclan y se sube lo que falte.
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
  return `${portfolio.name}|${portfolio.parentId ?? ""}|${portfolio.description ?? ""}|${JSON.stringify(portfolio.links ?? [])}`;
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
    /* almacenamiento lleno: se reintenta en la próxima sincronización */
  }
}

function snapshot(documents: Document[], portfolios: Portfolio[]): Pick<Meta, "docs" | "portfolios"> {
  return {
    docs: Object.fromEntries(documents.map((doc) => [doc.id, docSignature(doc)])),
    portfolios: Object.fromEntries(portfolios.map((portfolio) => [portfolio.id, portfolioSignature(portfolio)])),
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

/** Sincroniza ya; si hay una en curso, encadena otra al terminar. */
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
      // Navegador nuevo: la bóveda es la del servidor.
      useVault.getState().replaceVault(pulled.docs, pulled.portfolios);
      writeMeta(userId, { rev: pulled.revision, ...snapshot(pulled.docs, pulled.portfolios) });
      return;
    }
    meta = { rev: 0, docs: {}, portfolios: {} };
  }

  // 1. Aplicar lo que llegó, salvo lo que aquí cambió después.
  const local = useVault.getState();
  const localDocs = new Map(local.documents.map((doc) => [doc.id, doc]));
  const docs = pulled.docs.filter((remote) => {
    const mine = localDocs.get(remote.id);
    if (!mine) return true;
    if (local.conflicts[remote.id]) {
      // Pendiente de elegir: se ofrece la versión más reciente del servidor.
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

  // 2. Subir lo que cambió aquí.
  const now = useVault.getState();
  const changes = {
    // La nota nueva en blanco no se sube: si se deja así, se descarta (`Draft`).
    docs: now.documents.filter(
      (doc) => meta!.docs[doc.id] !== docSignature(doc) && !isBlankDraft(now.draft, doc) && !now.conflicts[doc.id],
    ),
    deletedDocs: Object.keys(meta.docs).filter((id) => !now.documents.some((doc) => doc.id === id)),
    portfolios: now.portfolios.filter((portfolio) => meta!.portfolios[portfolio.id] !== portfolioSignature(portfolio)),
    deletedPortfolios: Object.keys(meta.portfolios).filter((id) => !now.portfolios.some((portfolio) => portfolio.id === id)),
  };
  const total = changes.docs.length + changes.deletedDocs.length + changes.portfolios.length + changes.deletedPortfolios.length;
  if (total === 0) return;
  const result = await pushVault({ data: changes });
  if (!result.ok) {
    // Sin permiso de escritura: lo local se queda como estaba en el servidor la próxima vez.
    return;
  }
  const refused = new Set(result.conflicts.map((doc) => doc.id));
  useVault.getState().markSynced(changes.docs.filter((doc) => !refused.has(doc.id)));
  for (const theirs of result.conflicts) useVault.getState().setConflict(theirs);
  const after = snapshot(now.documents, now.portfolios);
  // Una nota en conflicto sigue contando como cambiada aquí.
  for (const id of refused) {
    if (meta.docs[id] === undefined) delete after.docs[id];
    else after.docs[id] = meta.docs[id];
  }
  // Si entre medias alguien más cambió la bóveda (la IA, otra pestaña), la
  // revisión saltó más de uno: se conserva la anterior para bajar esos cambios.
  // Lo mismo si el servidor juntó una nota: hay que bajar la versión mezclada.
  const rev = result.revision === meta.rev + 1 && result.merged.length === 0 ? result.revision : meta.rev;
  writeMeta(userId, { rev, ...after });
  if (rev !== result.revision) again = true;
}

/** Conflicto de una nota: se queda la versión del servidor (la de la otra persona). */
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
 * Conflicto de una nota: se queda la de aquí. Su base pasa a ser la versión
 * del servidor, así que al subirla la sustituye (lo anterior queda en el historial).
 */
export function keepMine(userId: string, id: string): void {
  const store = useVault.getState();
  const theirs = store.conflicts[id];
  if (!theirs) return;
  store.clearConflict(id);
  useVault.setState((state) => ({
    documents: state.documents.map((doc) =>
      doc.id === id ? { ...doc, base: { content: theirs.content, title: theirs.title, updatedAt: theirs.updatedAt } } : doc,
    ),
  }));
  void syncVault(userId);
}

/** Olvida el estado de sincronización (al borrar la caché local, por ejemplo). */
export function forgetSync(userId: string): void {
  try {
    localStorage.removeItem(META_PREFIX + userId);
  } catch {
    /* nada que borrar */
  }
}

/**
 * Mantiene la bóveda sincronizada mientras está abierta: al empezar, unos
 * segundos después de cada cambio local, cada 20 s y al volver a la pestaña.
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
