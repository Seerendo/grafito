/**
 * Folder and file counts for a portfolio, like a file manager's properties: what is directly
 * inside, and everything below it. Notes count as files. rootId null is the personal root.
 */

export type Tally = {
  direct: { folders: number; files: number };
  total: { folders: number; files: number };
};

export function tallyFolder(
  portfolios: readonly { id: string; parentId: string | null }[],
  documents: readonly { portfolioId: string | null }[],
  rootId: string | null,
): Tally {
  const children = new Map<string | null, string[]>();
  for (const portfolio of portfolios) {
    const siblings = children.get(portfolio.parentId) ?? [];
    siblings.push(portfolio.id);
    children.set(portfolio.parentId, siblings);
  }
  const filesIn = new Map<string | null, number>();
  for (const document of documents)
    filesIn.set(document.portfolioId, (filesIn.get(document.portfolioId) ?? 0) + 1);

  const direct = {
    folders: children.get(rootId)?.length ?? 0,
    files: filesIn.get(rootId) ?? 0,
  };
  const total = { folders: 0, files: direct.files };
  const seen = new Set<string>();
  const queue = [...(children.get(rootId) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    if (seen.has(id)) continue;
    seen.add(id);
    total.folders += 1;
    total.files += filesIn.get(id) ?? 0;
    queue.push(...(children.get(id) ?? []));
  }
  return { direct, total };
}
