/**
 * Qué ve un miembro de un espacio de trabajo que no lo administra.
 * El portafolio raíz siempre está (el espacio en sí). Una concesión deja ver
 * ese portafolio y sus documentos, no los de dentro: esos salen solo si
 * también se les concedió (o se replicó la concesión). Los portafolios de
 * en medio se ven vacíos, para poder llegar al concedido.
 */
export function visibleWorkspace<
  P extends { id: string; parentId: string | null },
  D extends { portfolioId: string | null },
>(rootId: string, portfolios: readonly P[], documents: readonly D[], granted: ReadonlySet<string>): {
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
    documents: documents.filter((document) => document.portfolioId !== null && granted.has(document.portfolioId)),
  };
}
