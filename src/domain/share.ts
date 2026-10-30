import { descendantIds } from "./vault/portfolios.ts";
import type { Portfolio } from "./vault/types.ts";

/**
 * Compartir en solo lectura. Lo privado no se guarda (es el valor por defecto);
 * `shared` lo ven los usuarios elegidos y `public` cualquiera con el enlace.
 */
export type Visibility = "private" | "shared" | "public";
export type ShareKind = "document" | "portfolio";

export type ShareTarget = { kind: ShareKind; targetId: string };

/** Lo mínimo de un documento para decidir si un elemento compartido lo cubre. */
type Placed = { id: string; portfolioId: string | null };
type Tree = Pick<Portfolio, "id" | "parentId">;

/**
 * Documentos y portafolios que cubre un elemento compartido: la nota sola, o
 * el portafolio con todos sus subportafolios y documentos.
 */
export function coveredBy(
  share: ShareTarget,
  portfolios: readonly Tree[],
  documents: readonly Placed[],
): { documentIds: Set<string>; portfolioIds: Set<string> } {
  if (share.kind === "document") {
    const exists = documents.some((document) => document.id === share.targetId);
    return { documentIds: new Set(exists ? [share.targetId] : []), portfolioIds: new Set() };
  }
  if (!portfolios.some((portfolio) => portfolio.id === share.targetId)) {
    return { documentIds: new Set(), portfolioIds: new Set() };
  }
  const portfolioIds = descendantIds(portfolios as Portfolio[], share.targetId);
  const documentIds = new Set(
    documents
      .filter((document) => document.portfolioId !== null && portfolioIds.has(document.portfolioId))
      .map((document) => document.id),
  );
  return { documentIds, portfolioIds };
}

/**
 * Si un vínculo manual apunta a algo que ese elemento compartido incluye.
 * Un portafolio no es un documento: si no se mira `target`, se pierde al
 * publicar el árbol.
 */
export function linkKept(
  link: { targetId: string; target?: string },
  covered: { documentIds: ReadonlySet<string>; portfolioIds: ReadonlySet<string> },
): boolean {
  if (link.target === "portfolio") return covered.portfolioIds.has(link.targetId);
  return covered.documentIds.has(link.targetId);
}

/** Unión de lo que cubren varios elementos compartidos. */
export function coveredByAll(
  shares: readonly ShareTarget[],
  portfolios: readonly Tree[],
  documents: readonly Placed[],
): { documentIds: Set<string>; portfolioIds: Set<string> } {
  const documentIds = new Set<string>();
  const portfolioIds = new Set<string>();
  for (const share of shares) {
    const covered = coveredBy(share, portfolios, documents);
    covered.documentIds.forEach((id) => documentIds.add(id));
    covered.portfolioIds.forEach((id) => portfolioIds.add(id));
  }
  return { documentIds, portfolioIds };
}

/** Visibilidad efectiva de un documento: la suya o la heredada de un portafolio. */
export function effectiveVisibility(
  documentId: string,
  shares: readonly (ShareTarget & { visibility: Exclude<Visibility, "private"> })[],
  portfolios: readonly Tree[],
  documents: readonly Placed[],
): Visibility {
  let result: Visibility = "private";
  for (const share of shares) {
    if (!coveredBy(share, portfolios, documents).documentIds.has(documentId)) continue;
    if (share.visibility === "public") return "public";
    result = "shared";
  }
  return result;
}
