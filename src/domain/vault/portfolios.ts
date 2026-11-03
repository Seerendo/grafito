import { subtreeIds } from "../hierarchy.ts";
import type { Document, Portfolio } from "./types";

export type PortfolioNode = {
  portfolio: Portfolio;
  children: PortfolioNode[];
  documents: Document[];
};

export function childPortfolios(portfolios: Portfolio[], parentId: string | null): Portfolio[] {
  return portfolios
    .filter((portfolio) => portfolio.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export function buildForest(
  portfolios: Portfolio[],
  documents: Document[],
): {
  loose: Document[];
  roots: PortfolioNode[];
} {
  const byParent = new Map<string | null, Document[]>();
  for (const document of documents) {
    const key = document.portfolioId;
    const list = byParent.get(key) ?? [];
    list.push(document);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title, "es"));
  }

  // Attach nodes in one pass instead of filtering all portfolios at every level.
  // Construction is iterative, so deeply nested imports do not exhaust the stack.
  const nodes = new Map<string, PortfolioNode>(
    portfolios.map((portfolio) => [
      portfolio.id,
      { portfolio, documents: byParent.get(portfolio.id) ?? [], children: [] },
    ]),
  );
  const roots: PortfolioNode[] = [];
  for (const node of nodes.values()) {
    if (node.portfolio.parentId === null) roots.push(node);
    else nodes.get(node.portfolio.parentId)?.children.push(node);
  }
  const byName = (a: PortfolioNode, b: PortfolioNode) =>
    a.portfolio.name.localeCompare(b.portfolio.name, "es");
  roots.sort(byName);
  for (const node of nodes.values()) node.children.sort(byName);
  return { loose: byParent.get(null) ?? [], roots };
}

export function descendantIds(
  portfolios: readonly Pick<Portfolio, "id" | "parentId">[],
  id: string,
): Set<string> {
  return subtreeIds(portfolios, id);
}
