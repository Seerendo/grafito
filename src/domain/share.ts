import { descendantIds } from "./vault/portfolios.ts";
import type { Portfolio } from "./vault/types.ts";

/**
 * Private visibility is implicit and unpersisted. shared is limited to selected users; public
 * allows anyone with the link.
 */
export type Visibility = "private" | "shared" | "public";
export type ShareKind = "document" | "portfolio";

export type ShareTarget = { kind: ShareKind; targetId: string };

/** Minimal document placement needed to determine share coverage. */
type Placed = { id: string; portfolioId: string | null };
type Tree = Pick<Portfolio, "id" | "parentId">;

/** Share coverage: one document, or a portfolio subtree and its documents. */
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
 * Whether a manual link targets content within this share. Check target kind so portfolio links
 * survive publication.
 */
export function linkKept(
  link: { targetId: string; target?: string },
  covered: { documentIds: ReadonlySet<string>; portfolioIds: ReadonlySet<string> },
): boolean {
  if (link.target === "portfolio") return covered.portfolioIds.has(link.targetId);
  return covered.documentIds.has(link.targetId);
}

/** Union of content covered by multiple shares. */
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

/** Document visibility, explicit or inherited from its portfolio. */
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
