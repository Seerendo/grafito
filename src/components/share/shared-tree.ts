import type { PublishedDoc, PublishedPortfolio, SharedTree } from "@/server/share";
import type { Document } from "@/domain/vault/types";

/** Shared portfolio/document traversal used by the viewer and directory. */

/** The shared portfolio is the index root; its parent is outside the share. */
export function rootParent(tree: SharedTree): string | null {
  const ids = new Set(tree.portfolios.map((portfolio) => portfolio.id));
  return (
    tree.portfolios.find((portfolio) => !portfolio.parentId || !ids.has(portfolio.parentId))
      ?.parentId ?? null
  );
}

export function childrenOf(tree: SharedTree, parentId: string | null): PublishedPortfolio[] {
  return tree.portfolios
    .filter((portfolio) => portfolio.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export function docsIn(tree: SharedTree, portfolioId: string | null): PublishedDoc[] {
  return tree.documents
    .filter((document) => document.portfolioId === portfolioId)
    .sort((a, b) => a.title.localeCompare(b.title, "es"));
}

function group<T>(map: Map<string | null, T[]>, key: string | null, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Documents in index order, used to select the default first document. */
export function orderDocuments(tree: SharedTree): PublishedDoc[] {
  if (tree.share.kind === "document") return tree.documents;
  // Group once; filtering at each level was quadratic for large trees.
  const kids = new Map<string | null, PublishedPortfolio[]>();
  for (const portfolio of tree.portfolios) group(kids, portfolio.parentId, portfolio);
  const docs = new Map<string | null, PublishedDoc[]>();
  for (const document of tree.documents) group(docs, document.portfolioId, document);
  const out: PublishedDoc[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    const level = [...(kids.get(parentId) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, "es"),
    );
    for (const portfolio of level) {
      if (seen.has(portfolio.id)) continue;
      seen.add(portfolio.id);
      out.push(
        ...[...(docs.get(portfolio.id) ?? [])].sort((a, b) => a.title.localeCompare(b.title, "es")),
      );
      walk(portfolio.id);
    }
  };
  walk(rootParent(tree));
  return out;
}

/** Whether content may be created or edited in this shared portfolio. */
export function canEditSharedPortfolio(tree: SharedTree, portfolioId: string | null): boolean {
  if (tree.share.access === "admin") return true;
  if (tree.share.folderAccess)
    return Boolean(portfolioId && tree.share.folderAccess[portfolioId] === "edit");
  return tree.share.access === "edit";
}

/** Access level displayed for the open shared portfolio. */
export function sharedPortfolioLevel(
  tree: SharedTree,
  portfolioId: string | null,
): "admin" | "edit" | "read" {
  if (tree.share.access === "admin") return "admin";
  if (tree.share.folderAccess) {
    const level = portfolioId ? tree.share.folderAccess[portfolioId] : undefined;
    return level === "edit" || level === "read" ? level : "read";
  }
  return tree.share.access === "edit" ? "edit" : "read";
}

/** Storage-and-permissions visibility; workspace administration is required for workspaces. */
export function canManageSharedSpace(tree: SharedTree): boolean {
  return !tree.share.workspace || tree.share.access === "admin";
}

/** Convert published content into vault documents for graph and links. */
export function asDocuments(documents: PublishedDoc[]): Document[] {
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    kind: document.kind,
    portfolioId: document.portfolioId,
    // Without lazy content, wiki links suffice for graph and mentions.
    content:
      document.lazy && !document.content
        ? (document.wikiLinks ?? []).map((title) => `[[${title}]]`).join("\n")
        : document.content,
    file: document.file ? { name: document.file.name, mime: document.file.mime } : null,
    links: document.links ?? [],
    pinned: false,
    createdAt: Date.parse(document.updatedAt),
    updatedAt: Date.parse(document.updatedAt),
    createdBy: document.updatedBy,
    updatedBy: document.updatedBy,
  }));
}
