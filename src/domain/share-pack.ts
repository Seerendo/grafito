import type { PublishedDoc, PublishedPortfolio, SharedTree } from "./shared-tree.ts";

/**
 * Serialize shared portfolios/documents as compact JSON rows. Reusing packed text avoids
 * repeated per-document serialization for large trees; see server/share.ts.
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
  /** Content text, or zero when fetched lazily on opening. */
  content: string | 0,
];
type PortfolioTuple = [id: string, name: string, parentId: string | null];

/** Packed document text cached by the server until the document changes. */
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
    document.file
      ? [document.file.name, document.file.mime, document.file.url, document.file.downloadUrl]
      : 0,
    document.lazy ? 0 : document.content,
  ];
  return JSON.stringify(tuple);
}

/** Assemble a body from documents already serialized by packDoc. */
export function packBodyFrom(portfolios: PublishedPortfolio[], packedDocs: string[]): string {
  const folders: PortfolioTuple[] = portfolios.map((portfolio) => [
    portfolio.id,
    portfolio.name,
    portfolio.parentId,
  ]);
  return `[${JSON.stringify(folders)},[${packedDocs.join(",")}]]`;
}

export function packBody(portfolios: PublishedPortfolio[], documents: PublishedDoc[]): string {
  return packBodyFrom(portfolios, documents.map(packDoc));
}

export function unpackTree(packed: PackedTree): SharedTree {
  const parsed = JSON.parse(packed.body) as [
    PortfolioTuple[],
    DocTuple[],
    [string, "read" | "edit"][]?,
  ];
  const [folders, docs, access] = parsed;
  return {
    share: {
      ...packed.share,
      ...(access && access.length > 0 ? { folderAccess: Object.fromEntries(access) } : {}),
    },
    portfolios: folders.map(([id, name, parentId]) => ({ id, name, parentId })),
    documents: docs.map(
      ([
        id,
        title,
        file,
        portfolioId,
        updatedAt,
        updatedBy,
        wikiLinks,
        links,
        fileInfo,
        content,
      ]) => ({
        id,
        title,
        kind: file ? "file" : "markdown",
        portfolioId,
        updatedAt,
        updatedBy,
        content: content === 0 ? "" : content,
        ...(content === 0 ? { lazy: true, wikiLinks: wikiLinks || [] } : {}),
        links: links || [],
        file: fileInfo
          ? { name: fileInfo[0], mime: fileInfo[1], url: fileInfo[2], downloadUrl: fileInfo[3] }
          : null,
      }),
    ),
  };
}
