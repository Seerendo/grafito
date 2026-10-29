import type { PublishedDoc, PublishedPortfolio, SharedTree } from "@/server/share";
import type { Document } from "@/domain/vault/types";

/**
 * Recorrido de un elemento compartido (portafolios y documentos de otro
 * usuario). Lo usan el visor y la sección «Compartidos conmigo» del directorio.
 */

/** El portafolio compartido es la raíz del índice; su padre queda fuera. */
export function rootParent(tree: SharedTree): string | null {
  const ids = new Set(tree.portfolios.map((portfolio) => portfolio.id));
  return tree.portfolios.find((portfolio) => !portfolio.parentId || !ids.has(portfolio.parentId))?.parentId ?? null;
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

/** Documentos en el orden del índice, para abrir el primero por defecto. */
export function orderDocuments(tree: SharedTree): PublishedDoc[] {
  if (tree.share.kind === "document") return tree.documents;
  const out: PublishedDoc[] = [];
  const walk = (parentId: string | null) => {
    for (const portfolio of childrenOf(tree, parentId)) {
      out.push(...docsIn(tree, portfolio.id));
      walk(portfolio.id);
    }
  };
  walk(rootParent(tree));
  return out;
}

/** Lo publicado como documentos de la bóveda, para el grafo y los vínculos. */
export function asDocuments(documents: PublishedDoc[]): Document[] {
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    kind: document.kind,
    portfolioId: document.portfolioId,
    content: document.content,
    file: document.file ? { name: document.file.name, mime: document.file.mime } : null,
    links: document.links ?? [],
    pinned: false,
    createdAt: Date.parse(document.updatedAt),
    updatedAt: Date.parse(document.updatedAt),
    createdBy: document.updatedBy,
    updatedBy: document.updatedBy,
  }));
}
