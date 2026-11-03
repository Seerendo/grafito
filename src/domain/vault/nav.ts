import type { Portfolio } from "./types";

/** Pure post-deletion navigation and ancestor expansion used by the store and tests. */

/** Path from id to root, including id; empty when no folder exists. */
export function portfolioPath(
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
  id: string | null,
): string[] {
  if (!id) return [];
  const byId = new Map(portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return path;
}

/** Expand id and its ancestors. collapsed=true means closed; false or absent means open. */
export function expandTo(
  collapsed: Record<string, boolean>,
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
  id: string | null,
): Record<string, boolean> {
  const path = portfolioPath(portfolios, id);
  if (path.every((item) => !collapsed[item])) return collapsed;
  const next = { ...collapsed };
  for (const item of path) next[item] = false;
  return next;
}

export type DeleteLanding = {
  activeId: string | null;
  selectedPortfolioId: string | null;
  folderPicked: boolean;
  rootPicked: boolean;
};

/**
 * When deleting the currently viewed item, open its surviving parent or personal root. Return
 * null if the active view is unaffected.
 */
export function landingAfterDelete(input: {
  activeId: string | null;
  folderPicked: boolean;
  selectedPortfolioId: string | null;
  removedDocs: ReadonlySet<string>;
  removedPortfolios: ReadonlySet<string>;
  activeDocPortfolioId: string | null;
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[];
}): DeleteLanding | null {
  const docRemoved = input.activeId !== null && input.removedDocs.has(input.activeId);
  const folderRemoved =
    input.folderPicked &&
    input.selectedPortfolioId !== null &&
    input.removedPortfolios.has(input.selectedPortfolioId) &&
    input.activeId === null;
  if (!docRemoved && !folderRemoved) return null;
  const start = docRemoved ? input.activeDocPortfolioId : input.selectedPortfolioId;
  const landed = climb(start, input.removedPortfolios, input.portfolios);
  if (!landed)
    return { activeId: null, selectedPortfolioId: null, folderPicked: false, rootPicked: true };
  return { activeId: null, selectedPortfolioId: landed, folderPicked: true, rootPicked: false };
}

/** First surviving ancestor from start, or null for the root. */
export function climb(
  start: string | null,
  removed: ReadonlySet<string>,
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
): string | null {
  const byId = new Map(portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const seen = new Set<string>();
  let id = start;
  while (id && removed.has(id) && !seen.has(id)) {
    seen.add(id);
    id = byId.get(id)?.parentId ?? null;
  }
  return id && !removed.has(id) ? id : null;
}

/**
 * Expansion keys for shared/workspace navigation. The share root uses its share ID; nested
 * folders use shareId:portfolioId. The root needs no second key.
 */
export function sharedExpandKeys(input: {
  shareId: string;
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[];
  rootId: string | null;
  portfolioId: string | null;
}): string[] {
  const keys = [input.shareId];
  const byId = new Map(input.portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const seen = new Set<string>();
  let id = input.portfolioId;
  while (id && id !== input.rootId && !seen.has(id)) {
    seen.add(id);
    keys.push(`${input.shareId}:${id}`);
    id = byId.get(id)?.parentId ?? null;
  }
  return keys;
}
