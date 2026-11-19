import type { Document, Portfolio, ViewMode } from "./types";

type LegacyNote = {
  id: string;
  title: string;
  folder: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
};

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function migrateLegacyVault(raw: unknown): {
  documents: Document[];
  portfolios: Portfolio[];
  activeId: string | null;
  mode: ViewMode;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as { notes?: unknown; activeId?: unknown; mode?: unknown };
  if (!Array.isArray(data.notes)) return null;
  const notes = data.notes.filter(isLegacyNote);
  if (notes.length === 0) return null;

  const portfolios: Portfolio[] = [];
  const pathToId = new Map<string, string>();
  const ensure = (path: string): string | null => {
    if (!path) return null;
    const existing = pathToId.get(path);
    if (existing) return existing;
    const parent = parentPath(path);
    const parentId = parent ? ensure(parent) : null;
    const name = parent ? path.slice(parent.length + 1) : path;
    const id = `p-${path}`;
    portfolios.push({ id, name, parentId });
    pathToId.set(path, id);
    return id;
  };

  const documents: Document[] = notes.map((note) => ({
    id: note.id,
    title: note.title,
    portfolioId: ensure(note.folder),
    kind: "markdown",
    content: note.content,
    file: null,
    links: [],
    createdAt: Number(note.createdAt) || Date.now(),
    updatedAt: Number(note.updatedAt) || Date.now(),
    createdBy: "Administrador",
    updatedBy: "Administrador",
    pinned: Boolean(note.pinned),
  }));

  const activeId = documents.some((document) => document.id === data.activeId)
    ? (data.activeId as string)
    : documents[0]!.id;
  const mode: ViewMode =
    data.mode === "edit" || data.mode === "split" || data.mode === "read" ? data.mode : "read";
  return { documents, portfolios, activeId, mode };
}

function isLegacyNote(value: unknown): value is LegacyNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Partial<LegacyNote>;
  return (
    typeof note.id === "string" &&
    typeof note.title === "string" &&
    typeof note.content === "string" &&
    typeof note.folder === "string"
  );
}

/** Root portfolio grouping sample notes. */
export const SAMPLE_ROOT_ID = "p-documentacion";
export const SAMPLE_ROOT_NAME = "Documentación";
const SAMPLE_PORTFOLIO_IDS = ["p-inicio", "p-atlas", "p-personal", "p-taller", "p-diario"];

/** Notes and files of the sample documentation (app/vault/seed.ts). */
export const SAMPLE_DOC_IDS = [
  "n-bitacora",
  "n-decisiones",
  "n-diagramas",
  "n-diario",
  "n-escribir",
  "n-fuentes",
  "n-grafo",
  "n-hipotesis",
  "n-inicio",
  "n-lectura",
  "n-mapa",
  "n-plano",
  "n-ritual",
];

/** Every portfolio of the sample documentation, its root included. */
export const SAMPLE_FOLDER_IDS = [SAMPLE_ROOT_ID, ...SAMPLE_PORTFOLIO_IDS];

/**
 * Once deleted, sample documentation stays deleted: a push that would bring back a sample note
 * or portfolio the server holds as deleted drops it. Restoring from the trash goes through the
 * server and is not a push.
 */
export function dropDeletedSamples<
  T extends { docs: { id: string }[]; portfolios: { id: string }[] },
>(changes: T, deleted: { docs: ReadonlySet<string>; portfolios: ReadonlySet<string> }): T {
  return {
    ...changes,
    docs: changes.docs.filter((doc) => !deleted.docs.has(doc.id)),
    portfolios: changes.portfolios.filter((portfolio) => !deleted.portfolios.has(portfolio.id)),
  };
}

/**
 * One-time migration nests legacy sample portfolios under Documentation. If that root already
 * exists, leave user organization unchanged. Return null when no changes are needed.
 */
export function nestSamplePortfolios(portfolios: Portfolio[]): Portfolio[] | null {
  if (portfolios.some((portfolio) => portfolio.id === SAMPLE_ROOT_ID)) return null;
  const loose = portfolios.filter(
    (portfolio) => portfolio.parentId === null && SAMPLE_PORTFOLIO_IDS.includes(portfolio.id),
  );
  if (loose.length === 0) return null;
  const named = portfolios.find(
    (portfolio) =>
      portfolio.parentId === null &&
      portfolio.name.trim().toLowerCase() === SAMPLE_ROOT_NAME.toLowerCase(),
  );
  const rootId = named?.id ?? SAMPLE_ROOT_ID;
  const moved = portfolios.map((portfolio) =>
    loose.includes(portfolio) ? { ...portfolio, parentId: rootId } : portfolio,
  );
  return named ? moved : [{ id: SAMPLE_ROOT_ID, name: SAMPLE_ROOT_NAME, parentId: null }, ...moved];
}
