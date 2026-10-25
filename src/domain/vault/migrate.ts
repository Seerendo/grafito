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

/** Portafolio raíz que agrupa las notas de ejemplo. */
export const SAMPLE_ROOT_ID = "p-documentacion";
export const SAMPLE_ROOT_NAME = "Documentación";
const SAMPLE_PORTFOLIO_IDS = ["p-inicio", "p-atlas", "p-personal", "p-taller", "p-diario"];

/**
 * Las bóvedas creadas antes de «Documentación» tienen los portafolios de
 * ejemplo en la raíz: los mueve dentro de ese portafolio (o de uno raíz que ya
 * se llame así). Se aplica una sola vez: si el raíz ya existe, no toca nada,
 * así que respeta a quien luego los mueva a mano. Devuelve `null` si no cambia.
 */
export function nestSamplePortfolios(portfolios: Portfolio[]): Portfolio[] | null {
  if (portfolios.some((portfolio) => portfolio.id === SAMPLE_ROOT_ID)) return null;
  const loose = portfolios.filter(
    (portfolio) => portfolio.parentId === null && SAMPLE_PORTFOLIO_IDS.includes(portfolio.id),
  );
  if (loose.length === 0) return null;
  const named = portfolios.find(
    (portfolio) => portfolio.parentId === null && portfolio.name.trim().toLowerCase() === SAMPLE_ROOT_NAME.toLowerCase(),
  );
  const rootId = named?.id ?? SAMPLE_ROOT_ID;
  const moved = portfolios.map((portfolio) =>
    loose.includes(portfolio) ? { ...portfolio, parentId: rootId } : portfolio,
  );
  return named ? moved : [{ id: SAMPLE_ROOT_ID, name: SAMPLE_ROOT_NAME, parentId: null }, ...moved];
}
