import { uuid } from "@/lib/uuid";
import { create } from "zustand";
import { actorName } from "@/app/actor";
import { findByTitle, replaceWikiTitle } from "@/domain/vault/links";
import { isTextAnchor, linkKey, type TextAnchor } from "@/domain/vault/anchor";
import { migrateLegacyVault, nestSamplePortfolios } from "@/domain/vault/migrate";
import { PERMISSION, deletePermission } from "@/domain/permissions";
import { descendantIds } from "@/domain/vault/portfolios";
import {
  type DialogState,
  type Document,
  type ManualKind,
  type ManualLink,
  type Portfolio,
  type SyncBase,
  type ViewMode,
} from "@/domain/vault/types";
import { can, subscribePermissions } from "@/app/permissions";
import { heldAdminId } from "@/app/vault-hold";
import { createSeed } from "./seed";
import { t } from "@/app/i18n";

/**
 * Cada usuario guarda su bóveda en su propia clave (`grafito.v2:<userId>`).
 * Las claves sin usuario son de versiones anteriores, compartidas por todo el
 * navegador: solo el administrador las adopta, una vez, y luego se borran.
 */
const STORAGE_PREFIX = "grafito.v2:";
const SHARED_KEY = "grafito.v2";
const LEGACY_KEY = "grafito.v1";

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/**
 * Nota recién creada que aún no se guardó: vive solo en este navegador hasta
 * que se le escribe algo. Si se deja en blanco (sin texto y con el título con
 * el que nació), al salir de ella se descarta. Ver `isBlankDraft`.
 */
export type Draft = { id: string; title: string };

type Persisted = {
  documents: Document[];
  portfolios: Portfolio[];
  activeId: string | null;
  mode: ViewMode;
  draft?: Draft | null;
};

/** Si `document` es la nota nueva y sigue en blanco (no se sube ni se guarda). */
export function isBlankDraft(draft: Draft | null | undefined, document: Document): boolean {
  return Boolean(
    draft && draft.id === document.id && document.kind === "markdown" && !document.content.trim() && document.title === draft.title,
  );
}

function isDocument(value: unknown): value is Document {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<Document>;
  return (
    typeof document.id === "string" &&
    typeof document.title === "string" &&
    (document.kind === "markdown" || document.kind === "file") &&
    typeof document.content === "string"
  );
}

const AUTHOR = "Administrador";

function authorOf(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : AUTHOR;
}

/**
 * Marca de un cambio hecho aquí. En una nota, recuerda además la versión del
 * servidor de la que parte (la primera vez que cambia desde que se sincronizó):
 * con ella el servidor junta este cambio con el de otra persona.
 */
function mark(document: Document): { updatedAt: number; updatedBy: string; base?: SyncBase } {
  const stamp = { updatedAt: Date.now(), updatedBy: actorName() };
  if (document.kind !== "markdown") return stamp;
  return {
    ...stamp,
    base: document.base ?? { content: document.content, title: document.title, updatedAt: document.updatedAt },
  };
}

function born(): { createdAt: number; updatedAt: number; createdBy: string; updatedBy: string } {
  const now = Date.now();
  const who = actorName();
  return { createdAt: now, updatedAt: now, createdBy: who, updatedBy: who };
}

function normalize(document: Document): Document {
  const links = Array.isArray(document.links)
    ? document.links
        .filter(
          (link) =>
            link &&
            typeof link.targetId === "string" &&
            (link.kind === "referencia" || link.kind === "llama"),
        )
        .map((link) => (link.anchor && !isTextAnchor(link.anchor) ? { targetId: link.targetId, kind: link.kind } : link))
    : [];
  return {
    id: document.id,
    title: document.title,
    portfolioId: typeof document.portfolioId === "string" ? document.portfolioId : null,
    kind: document.kind,
    content: document.content,
    file:
      document.file &&
      typeof document.file.name === "string" &&
      typeof document.file.mime === "string" &&
      (typeof document.file.key === "string" || typeof document.file.dataUrl === "string")
        ? document.file
        : null,
    links,
    createdAt: Number(document.createdAt) || Date.now(),
    updatedAt: Number(document.updatedAt) || Date.now(),
    createdBy: authorOf(document.createdBy),
    updatedBy: authorOf(document.updatedBy),
    pinned: Boolean(document.pinned),
    ...(document.base && typeof document.base.content === "string" ? { base: document.base } : {}),
  };
}

function isPortfolio(value: unknown): value is Portfolio {
  if (!value || typeof value !== "object") return false;
  const portfolio = value as Partial<Portfolio>;
  return typeof portfolio.id === "string" && typeof portfolio.name === "string";
}

function parseSaved(raw: string): Persisted | null {
  const data = JSON.parse(raw) as Partial<Persisted>;
  if (!Array.isArray(data.documents)) return null;
  const documents = data.documents.filter(isDocument).map(normalize);
  if (documents.length === 0) return null;
  const portfolios = Array.isArray(data.portfolios) ? data.portfolios.filter(isPortfolio) : [];
  // Sin documento abierto (la Carpeta Personal) se queda así al recargar; uno
  // que ya no existe también: no se abre otro cualquiera en su lugar.
  const activeId = documents.some((document) => document.id === data.activeId) ? (data.activeId as string) : null;
  const mode: ViewMode =
    data.mode === "edit" || data.mode === "split" || data.mode === "read" ? data.mode : "read";
  const draft =
    data.draft && typeof data.draft.id === "string" && typeof data.draft.title === "string" ? data.draft : null;
  return { documents, portfolios, activeId, mode, draft };
}

/** Bóveda compartida de versiones anteriores (sin usuario), si la hay. */
function loadShared(): Persisted | null {
  const current = localStorage.getItem(SHARED_KEY);
  if (current) return parseSaved(current);
  const legacy = localStorage.getItem(LEGACY_KEY);
  return legacy ? migrateLegacyVault(JSON.parse(legacy)) : null;
}

/**
 * Bóveda guardada de `userId`. Si no tiene, y `adoptShared`, la compartida de
 * versiones anteriores (`adopted: true`).
 */
function loadSaved(userId: string, adoptShared: boolean): { saved: Persisted | null; adopted: boolean } {
  if (typeof window === "undefined") return { saved: null, adopted: false };
  try {
    const own = localStorage.getItem(storageKey(userId));
    if (own) return { saved: parseSaved(own), adopted: false };
    if (!adoptShared) return { saved: null, adopted: false };
    const shared = loadShared();
    return { saved: shared, adopted: shared !== null };
  } catch {
    return { saved: null, adopted: false };
  }
}

function forgetShared(): void {
  try {
    localStorage.removeItem(SHARED_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function titleTaken(
  documents: Document[],
  title: string,
  portfolioId: string | null,
  kind: "markdown" | "file",
  exceptId?: string,
): boolean {
  return documents.some((document) => {
    if (document.id === exceptId) return false;
    if (!sameTitle(document.title, title)) return false;
    if (kind === "file") return document.portfolioId === portfolioId;
    if (document.kind === "markdown") return true;
    return document.portfolioId === portfolioId;
  });
}

function uniqueTitle(
  documents: Document[],
  base: string,
  portfolioId: string | null,
  kind: "markdown" | "file",
  exceptId?: string,
): string {
  const clean = base.trim() || t("Sin título");
  if (!titleTaken(documents, clean, portfolioId, kind, exceptId)) return clean;
  let index = 2;
  while (titleTaken(documents, `${clean} ${index}`, portfolioId, kind, exceptId)) index += 1;
  return `${clean} ${index}`;
}

function withTitle(documents: Document[], id: string, title: string): Document[] {
  const current = documents.find((document) => document.id === id);
  if (!current || current.title === title) return documents;
  return documents.map((document) => {
    if (document.id === id) {
      let content = document.content;
      const heading = `# ${current.title}`;
      if (document.kind === "markdown" && content.startsWith(heading)) {
        content = `# ${title}${content.slice(heading.length)}`;
      }
      return {
        ...document,
        title,
        content: document.kind === "markdown" ? replaceWikiTitle(content, current.title, title) : content,
        ...mark(document),
      };
    }
    if (document.kind !== "markdown") return document;
    const content = replaceWikiTitle(document.content, current.title, title);
    return content === document.content ? document : { ...document, content, ...mark(document) };
  });
}

type VaultState = Persisted & {
  selectedPortfolioId: string | null;
  rootPicked: boolean;
  /**
   * Si lo último que se eligió en el directorio fue una carpeta (la raíz o un
   * portafolio) y no un documento: solo entonces se resalta la carpeta. La
   * carpeta elegida (`selectedPortfolioId`) sigue decidiendo dónde se crean
   * las notas nuevas y dónde caen los archivos subidos.
   */
  folderPicked: boolean;
  collapsed: Record<string, boolean>;
  query: string;
  tag: string | null;
  graph: boolean;
  palette: boolean;
  dialog: DialogState;
  /** Usuario dueño de la bóveda en memoria; `null` hasta `openVaultFor`. */
  owner: string | null;
  /** La bóveda de `owner` ya se cargó y se puede guardar. */
  hydrated: boolean;
  /** La bóveda en memoria es la de ejemplo: no venía guardada en este navegador. */
  seeded: boolean;
  /** Aplica cambios llegados del servidor (sincronización, IA, API). */
  applyRemote: (changes: {
    docs: Document[];
    deletedDocs: string[];
    portfolios: Portfolio[];
    deletedPortfolios: string[];
  }) => void;
  /** Sustituye la bóveda entera por la del servidor. */
  replaceVault: (documents: Document[], portfolios: Portfolio[]) => void;
  /**
   * Notas que otra persona cambió a la vez que aquí, sin poder juntarse: la
   * versión del servidor, hasta que se elija cuál queda (ver `sync.ts`).
   */
  conflicts: Record<string, Document>;
  setConflict: (doc: Document) => void;
  clearConflict: (id: string) => void;
  /**
   * Tras subir: lo subido ya es la versión del servidor. Si la nota cambió
   * mientras se subía, su base pasa a ser lo subido.
   */
  markSynced: (pushed: Document[]) => void;
  /** Carga la bóveda de `userId` (o la de ejemplo si no tiene). */
  openVaultFor: (userId: string) => void;
  /** Guarda y descarga la bóveda en memoria (al salir). */
  closeVault: () => void;
  setActive: (id: string) => void;
  selectInGraph: (id: string) => void;
  setMode: (mode: ViewMode) => void;
  setQuery: (query: string) => void;
  setTag: (tag: string | null) => void;
  setGraph: (graph: boolean) => void;
  toggleGraph: () => void;
  setPalette: (palette: boolean) => void;
  setDialog: (dialog: DialogState) => void;
  setSelectedPortfolio: (id: string | null) => void;
  clearSelection: () => void;
  /** Vuelve al inicio: sin nota abierta, sin grafo, filtro ni diálogos. */
  showStart: () => void;
  toggleCollapsed: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  rename: (id: string, title: string) => boolean;
  togglePin: (id: string) => void;
  toggleTask: (id: string, line: number) => void;
  createDocument: (portfolioId?: string | null, title?: string, content?: string) => string;
  uploadFile: (portfolioId: string | null, name: string, mime: string, stored: { key: string; size: number }) => string | null;
  createPortfolio: (parentId: string | null, name: string) => void;
  deleteDocument: (id: string) => void;
  deletePortfolio: (id: string) => void;
  moveDocument: (id: string, portfolioId: string | null) => void;
  movePortfolio: (id: string, parentId: string | null) => void;
  /**
   * Mueve varios documentos y portafolios a la vez. Devuelve los títulos que no
   * se movieron porque en el destino ya hay un documento con ese nombre.
   */
  moveMany: (items: { kind: "document" | "portfolio"; id: string }[], target: string | null) => string[];
  renamePortfolio: (id: string, name: string) => boolean;
  resolveMove: (action: "replace" | "rename") => void;
  /** Con `anchor`, el vínculo sale de esa frase del archivo (puede haber varios al mismo destino). */
  /**
   * `sourceId` puede ser una nota, un archivo o un portafolio. `extra`: el
   * destino es un portafolio, o algo compartido conmigo (`shareId`).
   */
  addManualLink: (
    sourceId: string,
    targetId: string,
    kind: ManualKind,
    anchor?: TextAnchor,
    extra?: Pick<ManualLink, "target" | "shareId">,
  ) => void;
  removeManualLink: (sourceId: string, link: Pick<ManualLink, "targetId" | "anchor">) => void;
  /** La descripción de un portafolio (en su página). */
  /**
   * Quita los vínculos a lo compartido por `shareId` cuyo destino ya no se ve:
   * todos si `keep` es `null` (sin acceso), o los que no están en `keep`.
   */
  pruneShareLinks: (shareId: string, keep: Set<string> | null) => void;
  /** Una frase vinculada a la que ir al abrir su archivo (desde Menciones). */
  focusAnchor: { docId: string; anchor: TextAnchor } | null;
  setFocusAnchor: (focus: { docId: string; anchor: TextAnchor } | null) => void;
  openTitle: (title: string) => void;
  duplicate: (id: string) => void;
  importNote: (title: string, content: string, portfolioId?: string | null) => void;
  closeActive: () => void;
  /** Abre un portafolio en el centro: sus subportafolios, notas y archivos. */
  openPortfolio: (id: string) => void;
  reset: () => void;
};

/** Estado de una bóveda recién abierta: datos guardados o de ejemplo, UI limpia. */
function freshVault(saved: Persisted | null) {
  const seed = createSeed();
  return {
    documents: saved?.documents ?? seed.documents,
    portfolios: saved?.portfolios ?? seed.portfolios,
    activeId: saved ? saved.activeId : seed.activeId,
    mode: saved?.mode ?? ("read" as ViewMode),
    draft: saved?.draft ?? null,
    selectedPortfolioId: "p-inicio" as string | null,
    rootPicked: false,
    folderPicked: false,
    collapsed: {} as Record<string, boolean>,
    query: "",
    tag: null,
    graph: false,
    palette: false,
    dialog: null as DialogState,
  };
}

function persist(state: Pick<VaultState, "owner" | "hydrated" | keyof Persisted>): void {
  if (!state.hydrated || !state.owner) return;
  const payload: Persisted = {
    documents: state.documents,
    portfolios: state.portfolios,
    activeId: state.activeId,
    mode: state.mode,
    draft: state.draft,
  };
  try {
    localStorage.setItem(storageKey(state.owner), JSON.stringify(payload));
  } catch {
    /* almacenamiento lleno o no disponible */
  }
}

export const useVault = create<VaultState>((set, get) => ({
  ...freshVault(null),
  owner: null,
  hydrated: false,
  seeded: false,

  openVaultFor: (userId) => {
    if (get().owner === userId && get().hydrated) return;
    persist(get());
    // Solo el administrador hereda la bóveda compartida de versiones anteriores.
    const { saved, adopted } = loadSaved(userId, heldAdminId() === userId);
    const nested = saved ? nestSamplePortfolios(saved.portfolios) : null;
    set({
      ...freshVault(nested && saved ? { ...saved, portfolios: nested } : saved),
      owner: userId,
      hydrated: true,
      seeded: !saved,
    });
    settleDraft();
    if (nested) persist(get());
    if (adopted) {
      persist(get());
      forgetShared();
    }
  },

  closeVault: () => {
    persist(get());
    set({ ...freshVault(null), owner: null, hydrated: false, seeded: false });
  },

  applyRemote: (changes) => {
    const gone = new Set(changes.deletedDocs);
    const incoming = new Map(changes.docs.map((document) => [document.id, normalize(document)]));
    const documents = get()
      .documents.filter((document) => !gone.has(document.id))
      .map((document) => incoming.get(document.id) ?? document);
    const known = new Set(documents.map((document) => document.id));
    for (const document of incoming.values()) if (!known.has(document.id)) documents.unshift(document);
    const goneFolders = new Set(changes.deletedPortfolios);
    const folders = new Map(changes.portfolios.map((portfolio) => [portfolio.id, portfolio]));
    const portfolios = get()
      .portfolios.filter((portfolio) => !goneFolders.has(portfolio.id))
      .map((portfolio) => folders.get(portfolio.id) ?? portfolio);
    const knownFolders = new Set(portfolios.map((portfolio) => portfolio.id));
    for (const portfolio of folders.values()) if (!knownFolders.has(portfolio.id)) portfolios.push(portfolio);
    const activeId = get().activeId;
    set({
      documents,
      portfolios,
      activeId: activeId && gone.has(activeId) ? null : activeId,
      seeded: false,
    });
  },

  conflicts: {},

  setConflict: (doc) => set({ conflicts: { ...get().conflicts, [doc.id]: doc } }),

  clearConflict: (id) => {
    const { [id]: _gone, ...rest } = get().conflicts;
    set({ conflicts: rest });
  },

  markSynced: (pushed) => {
    const sent = new Map(pushed.map((doc) => [doc.id, doc]));
    let touched = false;
    const documents = get().documents.map((document) => {
      const doc = sent.get(document.id);
      if (!doc || !document.base) return document;
      touched = true;
      if (document === doc) {
        const { base: _base, ...synced } = document;
        return synced;
      }
      return { ...document, base: { content: doc.content, title: doc.title, updatedAt: doc.updatedAt } };
    });
    if (touched) set({ documents });
  },

  replaceVault: (documents, portfolios) => {
    const activeId = get().activeId;
    set({
      documents: documents.map(normalize),
      portfolios,
      activeId: documents.some((document) => document.id === activeId) ? activeId : null,
      seeded: false,
    });
  },

  setActive: (id) => set({ activeId: id, graph: false, palette: false, folderPicked: false }),
  selectInGraph: (id) => set({ activeId: id, palette: false, folderPicked: false }),
  closeActive: () => set({ activeId: null, graph: false }),
  openPortfolio: (id) =>
    set({ activeId: null, graph: false, palette: false, selectedPortfolioId: id, rootPicked: false, folderPicked: true }),
  setMode: (mode) => {
    if (mode !== "read" && !can(PERMISSION.notesEdit)) return;
    set({ mode });
  },
  setQuery: (query) => set({ query }),
  setTag: (tag) => set({ tag, palette: false }),
  setGraph: (graph) => {
    if (graph && !can(PERMISSION.graphView)) return;
    set({ graph, palette: false });
  },
  toggleGraph: () => get().setGraph(!get().graph),
  setPalette: (palette) => set({ palette }),
  setDialog: (dialog) => set({ dialog, palette: false }),
  setSelectedPortfolio: (id) => set({ selectedPortfolioId: id, rootPicked: id === null, folderPicked: true }),
  clearSelection: () =>
    set({ activeId: null, graph: false, selectedPortfolioId: null, rootPicked: false, folderPicked: false }),
  showStart: () =>
    set({
      activeId: null,
      graph: false,
      selectedPortfolioId: null,
      rootPicked: false,
      folderPicked: false,
      palette: false,
      dialog: null,
      query: "",
      tag: null,
    }),
  toggleCollapsed: (id) =>
    set((state) => ({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })),

  updateContent: (id, content) => {
    if (!can(PERMISSION.notesEdit)) return;
    set((state) => ({
      documents: state.documents.map((document) =>
        document.id === id ? { ...document, content, ...mark(document) } : document,
      ),
    }));
  },

  rename: (id, raw) => {
    if (!can(PERMISSION.notesEdit)) return false;
    const title = raw.trim();
    if (!title) return false;
    const current = get().documents.find((document) => document.id === id);
    if (!current) return false;
    if (current.title === title) return true;
    if (titleTaken(get().documents, title, current.portfolioId, current.kind, id)) return false;
    set({ documents: withTitle(get().documents, id, title) });
    return true;
  },

  togglePin: (id) =>
    set((state) => ({
      documents: state.documents.map((document) =>
        document.id === id ? { ...document, pinned: !document.pinned } : document,
      ),
    })),

  toggleTask: (id, line) => {
    if (!can(PERMISSION.notesEdit)) return;
    set((state) => ({
      documents: state.documents.map((document) => {
        if (document.id !== id || document.kind !== "markdown") return document;
        const lines = document.content.split("\n");
        const current = lines[line];
        if (!current) return document;
        lines[line] = current.includes("[ ]")
          ? current.replace("[ ]", "[x]")
          : current.replace(/\[(x|X)\]/, "[ ]");
        return { ...document, content: lines.join("\n"), ...mark(document) };
      }),
    }));
  },

  createDocument: (portfolioId, title, content) => {
    if (!can(PERMISSION.notesCreate)) return "";
    const target = portfolioId === undefined ? get().selectedPortfolioId : portfolioId;
    const name = uniqueTitle(get().documents, title?.trim() || t("Sin título"), target, "markdown");
    // Sin contenido dado, la nota nace en blanco y es un borrador (`Draft`).
    const blank = content === undefined;
    const document: Document = {
      id: uuid(),
      title: name,
      portfolioId: target,
      kind: "markdown",
      content: content ?? "",
      file: null,
      links: [],
      ...born(),
      pinned: false,
    };
    set({
      documents: [document, ...get().documents],
      activeId: document.id,
      folderPicked: false,
      graph: false,
      palette: false,
      selectedPortfolioId: target,
      ...(blank ? { draft: { id: document.id, title: name } } : {}),
    });
    return document.id;
  },

  uploadFile: (portfolioId, name, mime, stored) => {
    if (!can(PERMISSION.filesUpload)) return t("Tu rol no permite subir archivos.");
    const base = name.replace(/\.[^.]+$/, "") || name;
    const title = uniqueTitle(get().documents, base, portfolioId, "file");
    const document: Document = {
      id: uuid(),
      title,
      portfolioId,
      kind: "file",
      content: "",
      file: { name, mime: mime || "application/octet-stream", key: stored.key, size: stored.size },
      links: [],
      ...born(),
      pinned: false,
    };
    set({
      documents: [document, ...get().documents],
      activeId: document.id,
      folderPicked: false,
      graph: false,
      palette: false,
      selectedPortfolioId: portfolioId,
    });
    return null;
  },

  createPortfolio: (parentId, name) => {
    if (!can(PERMISSION.portfoliosManage)) return;
    const clean = name.trim().replace(/[\\/]/g, "");
    if (!clean) return;
    const id = uuid();
    set({
      portfolios: [...get().portfolios, { id, name: clean, parentId }],
      selectedPortfolioId: id,
      dialog: null,
      collapsed: { ...get().collapsed, [id]: false, ...(parentId ? { [parentId]: false } : {}) },
    });
  },

  deleteDocument: (id) => {
    const target = get().documents.find((document) => document.id === id);
    if (!target || !can(deletePermission(target.kind))) return;
    const documents = get()
      .documents.filter((document) => document.id !== id)
      .map((document) => ({
        ...document,
        links: document.links.filter((link) => link.targetId !== id),
      }));
    set({
      documents,
      activeId: get().activeId === id ? (documents[0]?.id ?? null) : get().activeId,
      dialog: null,
    });
  },

  deletePortfolio: (id) => {
    if (!can(PERMISSION.portfoliosManage)) return;
    const portfolio = get().portfolios.find((item) => item.id === id);
    if (!portfolio) return;
    const drop = descendantIds(get().portfolios, id);
    const removed = new Set(
      get()
        .documents.filter((document) => document.portfolioId && drop.has(document.portfolioId))
        .map((document) => document.id),
    );
    const documents = get()
      .documents.filter((document) => !removed.has(document.id))
      .map((document) => ({
        ...document,
        links: document.links.filter((link) => !removed.has(link.targetId)),
      }));
    const selected = get().selectedPortfolioId;
    const activeId = get().activeId;
    set({
      portfolios: get().portfolios.filter((item) => !drop.has(item.id)),
      documents,
      activeId: activeId !== null && removed.has(activeId) ? null : activeId,
      selectedPortfolioId: selected !== null && drop.has(selected) ? portfolio.parentId : selected,
      dialog: null,
    });
  },

  moveDocument: (id, portfolioId) => {
    if (!can(PERMISSION.portfoliosManage)) return;
    const current = get().documents.find((document) => document.id === id);
    if (!current || current.portfolioId === portfolioId) return;
    if (portfolioId && !get().portfolios.some((portfolio) => portfolio.id === portfolioId)) return;
    const existing = get().documents.find(
      (document) =>
        document.id !== id &&
        document.portfolioId === portfolioId &&
        sameTitle(document.title, current.title),
    );
    if (existing) {
      set({ dialog: { type: "move-conflict", id, portfolioId, existingId: existing.id } });
      return;
    }
    set({
      documents: get().documents.map((document) =>
        document.id === id ? { ...document, portfolioId, ...mark(document) } : document,
      ),
      collapsed: portfolioId ? { ...get().collapsed, [portfolioId]: false } : get().collapsed,
      selectedPortfolioId: portfolioId,
    });
  },

  movePortfolio: (id, parentId) => {
    if (!can(PERMISSION.portfoliosManage)) return;
    if (id === parentId) return;
    if (parentId && !get().portfolios.some((portfolio) => portfolio.id === parentId)) return;
    const blocked = descendantIds(get().portfolios, id);
    if (parentId && blocked.has(parentId)) return;
    set({
      portfolios: get().portfolios.map((portfolio) =>
        portfolio.id === id ? { ...portfolio, parentId } : portfolio,
      ),
      collapsed: parentId ? { ...get().collapsed, [parentId]: false } : get().collapsed,
      selectedPortfolioId: id,
    });
  },

  moveMany: (items, target) => {
    if (!can(PERMISSION.portfoliosManage)) return [];
    const { documents, portfolios } = get();
    if (target && !portfolios.some((portfolio) => portfolio.id === target)) return [];
    // Lo que está dentro de un portafolio también elegido viaja con él: no se saca de ahí.
    const pickedPortfolios = items.filter((item) => item.kind === "portfolio").map((item) => item.id);
    const insidePicked = (portfolioId: string | null): boolean => {
      for (let id = portfolioId, steps = 0; id && steps < 100; steps += 1) {
        if (pickedPortfolios.includes(id)) return true;
        id = portfolios.find((portfolio) => portfolio.id === id)?.parentId ?? null;
      }
      return false;
    };
    items = items.filter((item) =>
      item.kind === "document"
        ? !insidePicked(documents.find((document) => document.id === item.id)?.portfolioId ?? null)
        : !insidePicked(portfolios.find((portfolio) => portfolio.id === item.id)?.parentId ?? null),
    );
    const docIds = new Set<string>();
    const skipped: string[] = [];
    for (const item of items) {
      if (item.kind !== "document") continue;
      const current = documents.find((document) => document.id === item.id);
      if (!current || current.portfolioId === target) continue;
      const clash = documents.some(
        (document) =>
          document.id !== current.id &&
          !docIds.has(document.id) &&
          document.portfolioId === target &&
          sameTitle(document.title, current.title),
      );
      // Dos de la selección con el mismo nombre también chocan entre sí.
      const twin = documents.some((document) => docIds.has(document.id) && sameTitle(document.title, current.title));
      if (clash || twin) skipped.push(current.title);
      else docIds.add(current.id);
    }
    const portIds = new Set(
      items
        .filter((item) => item.kind === "portfolio" && item.id !== target)
        // Un portafolio no puede ir dentro de sí mismo.
        .filter((item) => !target || !descendantIds(portfolios, item.id).has(target))
        .map((item) => item.id),
    );
    set({
      documents: documents.map((document) =>
        docIds.has(document.id) ? { ...document, portfolioId: target, ...mark(document) } : document,
      ),
      portfolios: portfolios.map((portfolio) => (portIds.has(portfolio.id) ? { ...portfolio, parentId: target } : portfolio)),
      collapsed: target ? { ...get().collapsed, [target]: false } : get().collapsed,
    });
    return skipped;
  },

  renamePortfolio: (id, name) => {
    if (!can(PERMISSION.portfoliosManage)) return false;
    const clean = name.trim().replace(/[\\/]/g, "");
    if (!clean) return false;
    if (!get().portfolios.some((portfolio) => portfolio.id === id)) return false;
    set({
      portfolios: get().portfolios.map((portfolio) =>
        portfolio.id === id ? { ...portfolio, name: clean } : portfolio,
      ),
      dialog: null,
    });
    return true;
  },

  resolveMove: (action) => {
    if (!can(PERMISSION.portfoliosManage)) return;
    const dialog = get().dialog;
    if (!dialog || dialog.type !== "move-conflict") return;
    const source = get().documents.find((document) => document.id === dialog.id);
    if (!source) {
      set({ dialog: null });
      return;
    }
    if (action === "replace") {
      const documents = get()
        .documents.filter((document) => document.id !== dialog.existingId)
        .map((document) => ({
          ...document,
          portfolioId: document.id === source.id ? dialog.portfolioId : document.portfolioId,
          ...(document.id === source.id ? mark(document) : { updatedAt: document.updatedAt, updatedBy: document.updatedBy }),
          links: document.links
            .filter((link) => !(document.id === source.id && link.targetId === dialog.existingId))
            .map((link) =>
              link.targetId === dialog.existingId ? { ...link, targetId: source.id } : link,
            ),
        }));
      set({
        documents,
        activeId: get().activeId === dialog.existingId ? source.id : get().activeId,
        collapsed: dialog.portfolioId ? { ...get().collapsed, [dialog.portfolioId]: false } : get().collapsed,
        selectedPortfolioId: dialog.portfolioId,
        dialog: null,
      });
      return;
    }
    const title = uniqueTitle(get().documents, source.title, dialog.portfolioId, source.kind, source.id);
    const documents = withTitle(get().documents, source.id, title).map((document) =>
      document.id === source.id
        ? { ...document, portfolioId: dialog.portfolioId, ...mark(document) }
        : document,
    );
    set({
      documents,
      collapsed: dialog.portfolioId ? { ...get().collapsed, [dialog.portfolioId]: false } : get().collapsed,
      selectedPortfolioId: dialog.portfolioId,
      dialog: null,
    });
  },

  addManualLink: (sourceId, targetId, kind, anchor, extra) => {
    if (!can(PERMISSION.linksManage)) return;
    if (sourceId === targetId) return;
    const added: ManualLink = {
      targetId,
      kind,
      ...(anchor ? { anchor } : {}),
      ...(extra?.target ? { target: extra.target } : {}),
      ...(extra?.shareId ? { shareId: extra.shareId } : {}),
    };
    const key = linkKey(added);
    set({
      documents: get().documents.map((document) => {
        if (document.id !== sourceId) return document;
        const links = document.links.filter((link) => linkKey(link) !== key);
        return { ...document, links: [...links, added], ...mark(document) };
      }),
      portfolios: get().portfolios.map((portfolio) => {
        if (portfolio.id !== sourceId) return portfolio;
        const links = (portfolio.links ?? []).filter((link) => linkKey(link) !== key);
        return { ...portfolio, links: [...links, added] };
      }),
      dialog: null,
    });
  },

  removeManualLink: (sourceId, removed) => {
    if (!can(PERMISSION.linksManage)) return;
    const key = linkKey(removed);
    set({
      documents: get().documents.map((document) =>
        document.id === sourceId
          ? {
              ...document,
              links: document.links.filter((link) => linkKey(link) !== key),
              ...mark(document),
            }
          : document,
      ),
      portfolios: get().portfolios.map((portfolio) =>
        portfolio.id === sourceId
          ? { ...portfolio, links: (portfolio.links ?? []).filter((link) => linkKey(link) !== key) }
          : portfolio,
      ),
    });
  },

  pruneShareLinks: (shareId, keep) => {
    const gone = (link: ManualLink) => link.shareId === shareId && (keep === null || !keep.has(link.targetId));
    const { documents, portfolios } = get();
    if (!documents.some((document) => document.links.some(gone)) && !portfolios.some((portfolio) => (portfolio.links ?? []).some(gone))) {
      return;
    }
    set({
      documents: documents.map((document) =>
        document.links.some(gone) ? { ...document, links: document.links.filter((link) => !gone(link)), ...mark(document) } : document,
      ),
      portfolios: portfolios.map((portfolio) =>
        (portfolio.links ?? []).some(gone) ? { ...portfolio, links: (portfolio.links ?? []).filter((link) => !gone(link)) } : portfolio,
      ),
    });
  },

  focusAnchor: null,
  setFocusAnchor: (focus) => set({ focusAnchor: focus }),

  openTitle: (title) => {
    const found = findByTitle(get().documents, title);
    if (found) {
      set({ activeId: found.id, graph: false, palette: false });
      return;
    }
    const portfolioId = get().documents.find((document) => document.id === get().activeId)?.portfolioId ?? null;
    get().createDocument(portfolioId, title);
  },

  duplicate: (id) => {
    if (!can(PERMISSION.notesCreate)) return;
    const source = get().documents.find((document) => document.id === id);
    if (!source || source.kind !== "markdown") return;
    const title = uniqueTitle(get().documents, `${source.title} copia`, source.portfolioId, "markdown");
    const heading = `# ${source.title}`;
    const content = source.content.startsWith(heading)
      ? `# ${title}${source.content.slice(heading.length)}`
      : source.content;
    get().createDocument(source.portfolioId, title, content);
  },

  importNote: (title, content, portfolioId) => {
    if (!can(PERMISSION.notesCreate)) return;
    if (portfolioId !== undefined) {
      const name = title.replace(/\.(md|markdown)$/i, "").trim() || t("Sin título");
      get().createDocument(portfolioId, name, content);
      return;
    }
    const existing = get().portfolios.find((portfolio) => portfolio.name === "Importadas" && !portfolio.parentId);
    const importedId = existing?.id ?? uuid();
    if (!existing) {
      set({ portfolios: [...get().portfolios, { id: importedId, name: t("Importadas"), parentId: null }] });
    }
    get().createDocument(importedId, title.replace(/\.md$/i, ""), content);
  },

  reset: () => {
    if (!can(PERMISSION.notesCreate) || !can(PERMISSION.notesDelete)) return;
    set({ ...freshVault(null), hydrated: get().owner !== null });
  },
}));

subscribePermissions(() => {
  const state = useVault.getState();
  const patch: Partial<VaultState> = {};
  if (state.mode !== "read" && !can(PERMISSION.notesEdit)) patch.mode = "read";
  if (state.graph && !can(PERMISSION.graphView)) patch.graph = false;
  if (Object.keys(patch).length > 0) useVault.setState(patch);
});

/**
 * Al salir de la nota nueva (otra nota, la raíz, Esc, recargar en otra): si
 * sigue en blanco se descarta; si ya tiene algo, deja de ser borrador.
 */
function settleDraft(): void {
  const state = useVault.getState();
  const draft = state.draft;
  if (!draft || state.activeId === draft.id) return;
  const document = state.documents.find((item) => item.id === draft.id);
  if (document && isBlankDraft(draft, document)) {
    useVault.setState({ documents: state.documents.filter((item) => item.id !== draft.id), draft: null });
  } else {
    useVault.setState({ draft: null });
  }
}

useVault.subscribe((state, previous) => {
  if (state.activeId !== previous.activeId && previous.draft && previous.activeId === previous.draft.id) settleDraft();
});

const persistFlag = "__grafitoPersistV3";
if (typeof window !== "undefined" && !(persistFlag in window)) {
  Object.defineProperty(window, persistFlag, { value: true });
  let timer = 0;
  useVault.subscribe((state, previous) => {
    // Al cambiar de dueño, `openVaultFor` / `closeVault` ya guardaron.
    if (state.owner !== previous.owner) {
      window.clearTimeout(timer);
      return;
    }
    if (!state.hydrated) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => persist(useVault.getState()), 200);
  });
  window.addEventListener("pagehide", () => {
    window.clearTimeout(timer);
    persist(useVault.getState());
  });
}

export function useActiveDocument(): Document | null {
  return useVault((state) => state.documents.find((document) => document.id === state.activeId) ?? null);
}
