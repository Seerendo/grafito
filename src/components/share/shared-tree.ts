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

function group<T>(map: Map<string | null, T[]>, key: string | null, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Documentos en el orden del índice, para abrir el primero por defecto. */
export function orderDocuments(tree: SharedTree): PublishedDoc[] {
  if (tree.share.kind === "document") return tree.documents;
  // Agrupados una vez (con miles de documentos, filtrar en cada nivel era cuadrático).
  const kids = new Map<string | null, PublishedPortfolio[]>();
  for (const portfolio of tree.portfolios) group(kids, portfolio.parentId, portfolio);
  const docs = new Map<string | null, PublishedDoc[]>();
  for (const document of tree.documents) group(docs, document.portfolioId, document);
  const out: PublishedDoc[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    const level = [...(kids.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, "es"));
    for (const portfolio of level) {
      if (seen.has(portfolio.id)) continue;
      seen.add(portfolio.id);
      out.push(...[...(docs.get(portfolio.id) ?? [])].sort((a, b) => a.title.localeCompare(b.title, "es")));
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
    // Sin el texto (`lazy`), sus `[[vínculos]]` bastan para el grafo y las menciones.
    content:
      document.lazy && !document.content ? (document.wikiLinks ?? []).map((title) => `[[${title}]]`).join("\n") : document.content,
    file: document.file ? { name: document.file.name, mime: document.file.mime } : null,
    links: document.links ?? [],
    pinned: false,
    createdAt: Date.parse(document.updatedAt),
    updatedAt: Date.parse(document.updatedAt),
    createdBy: document.updatedBy,
    updatedBy: document.updatedBy,
  }));
}
