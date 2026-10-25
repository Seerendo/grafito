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

export function buildForest(portfolios: Portfolio[], documents: Document[]): {
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

  const walk = (portfolio: Portfolio): PortfolioNode => ({
    portfolio,
    documents: byParent.get(portfolio.id) ?? [],
    children: childPortfolios(portfolios, portfolio.id).map(walk),
  });

  return {
    loose: byParent.get(null) ?? [],
    roots: childPortfolios(portfolios, null).map(walk),
  };
}

export function descendantIds(portfolios: Portfolio[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const portfolio of portfolios) {
      if (portfolio.parentId && ids.has(portfolio.parentId) && !ids.has(portfolio.id)) {
        ids.add(portfolio.id);
        grew = true;
      }
    }
  }
  return ids;
}
