/**
 * Non-admin workspace visibility: always show the root. A grant exposes that portfolio and its
 * documents, not descendants without grants. Intermediate folders appear empty for navigation.
 */
export function visibleWorkspace<
  P extends { id: string; parentId: string | null },
  D extends { portfolioId: string | null },
>(
  rootId: string,
  portfolios: readonly P[],
  documents: readonly D[],
  granted: ReadonlySet<string>,
): {
  portfolios: P[];
  documents: D[];
} {
  const byId = new Map(portfolios.map((portfolio) => [portfolio.id, portfolio]));
  const visible = new Set<string>();
  if (byId.has(rootId)) visible.add(rootId);
  for (const id of granted) {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current && byId.has(current) && !seen.has(current)) {
      seen.add(current);
      visible.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
  }
  return {
    portfolios: portfolios.filter((portfolio) => visible.has(portfolio.id)),
    documents: documents.filter(
      (document) => document.portfolioId !== null && granted.has(document.portfolioId),
    ),
  };
}
