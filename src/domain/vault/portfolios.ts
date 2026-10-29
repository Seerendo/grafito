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

export function descendantIds(portfolios: readonly Pick<Portfolio, "id" | "parentId">[], id: string): Set<string> {
  // Una pasada para saber los hijos de cada uno y otra para recorrer: lineal
  // aunque haya muchos niveles (antes, una vuelta completa por nivel).
  const children = new Map<string, string[]>();
  for (const portfolio of portfolios) {
    if (!portfolio.parentId) continue;
    const list = children.get(portfolio.parentId);
    if (list) list.push(portfolio.id);
    else children.set(portfolio.parentId, [portfolio.id]);
  }
  const ids = new Set<string>([id]);
  const queue = [id];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]!) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return ids;
}
