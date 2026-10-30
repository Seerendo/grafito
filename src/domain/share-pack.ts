import type { PublishedDoc, PublishedPortfolio, SharedTree } from "@/server/share";

/**
 * Cómo viaja el árbol de algo compartido: los portafolios y documentos como un
 * solo texto JSON compacto (una fila por elemento) en vez de un objeto por
 * documento. Con miles de documentos, serializar objeto a objeto era lo que
 * más costaba al servidor; un texto ya armado se puede además guardar y
 * reutilizar para todos los que abren lo mismo (ver `share.ts`).
 */

export type PackedTree = { share: SharedTree["share"]; body: string };

type FileTuple = [name: string, mime: string, url: string, downloadUrl: string | null];
type DocTuple = [
  id: string,
  title: string,
  file: 0 | 1,
  portfolioId: string | null,
  updatedAt: string,
  updatedBy: string,
  wikiLinks: string[] | 0,
  links: NonNullable<PublishedDoc["links"]> | 0,
  fileInfo: FileTuple | 0,
  /** El texto, o 0 si se pide al abrirlo (`lazy`). */
  content: string | 0,
];
type PortfolioTuple = [id: string, name: string, parentId: string | null];

/** Un documento ya empaquetado (el servidor guarda este texto mientras el documento no cambie). */
export function packDoc(document: PublishedDoc): string {
  const tuple: DocTuple = [
    document.id,
    document.title,
    document.kind === "file" ? 1 : 0,
    document.portfolioId,
    document.updatedAt,
    document.updatedBy,
    document.wikiLinks?.length ? document.wikiLinks : 0,
    document.links?.length ? document.links : 0,
    document.file ? [document.file.name, document.file.mime, document.file.url, document.file.downloadUrl] : 0,
    document.lazy ? 0 : document.content,
  ];
  return JSON.stringify(tuple);
}

/** El cuerpo a partir de los documentos ya empaquetados (`packDoc`). */
export function packBodyFrom(portfolios: PublishedPortfolio[], packedDocs: string[]): string {
  const folders: PortfolioTuple[] = portfolios.map((portfolio) => [portfolio.id, portfolio.name, portfolio.parentId]);
  return `[${JSON.stringify(folders)},[${packedDocs.join(",")}]]`;
}

export function packBody(portfolios: PublishedPortfolio[], documents: PublishedDoc[]): string {
  return packBodyFrom(portfolios, documents.map(packDoc));
}

export function unpackTree(packed: PackedTree): SharedTree {
  const parsed = JSON.parse(packed.body) as [PortfolioTuple[], DocTuple[], [string, "read" | "edit"][]?];
  const [folders, docs, access] = parsed;
  return {
    share: {
      ...packed.share,
      ...(access && access.length > 0 ? { folderAccess: Object.fromEntries(access) } : {}),
    },
    portfolios: folders.map(([id, name, parentId]) => ({ id, name, parentId })),
    documents: docs.map(([id, title, file, portfolioId, updatedAt, updatedBy, wikiLinks, links, fileInfo, content]) => ({
      id,
      title,
      kind: file ? "file" : "markdown",
      portfolioId,
      updatedAt,
      updatedBy,
      content: content === 0 ? "" : content,
      ...(content === 0 ? { lazy: true, wikiLinks: wikiLinks || [] } : {}),
      links: links || [],
      file: fileInfo ? { name: fileInfo[0], mime: fileInfo[1], url: fileInfo[2], downloadUrl: fileInfo[3] } : null,
    })),
  };
}
