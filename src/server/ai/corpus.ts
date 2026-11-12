import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { readSlice } from "@/domain/ai-read";
import { namedInQuestion } from "./guard.ts";
import { INDEX_CAP } from "@/domain/search-text";
import { locatePhrase, MAX_EXACT, type PhraseLocation } from "@/domain/vault/anchor";
import type { Document, ManualKind, ManualLink } from "@/domain/vault/types";
import { unpackTree } from "@/domain/share-pack";
import { isPdfFile } from "@/domain/signature-box";
import { isTableName, tableColumnNames } from "@/domain/vault/table";
import { documentPdfPages, fileText } from "@/server/files";
import { indexedBody, queryContent } from "@/server/index/query";
import {
  editableTarget,
  grantedDocOwner,
  mayWriteInPortfolio,
  sharedTreeForUser,
  sharedWith,
  shareForUser,
} from "@/server/share";
import { subtree } from "@/server/space";
import {
  addNamedRow,
  createTable as saveTable,
  queryRows,
  readFields,
  saveField,
  updateCell,
} from "@/server/table";
import { uploadTarget } from "@/server/upload-target";
import { changeSharedLink } from "@/server/shared-link";
import {
  attachManualLink,
  createNote as saveNote,
  createPortfolio as savePortfolio,
  deleteDoc,
  getDoc,
  listDocs,
  listPortfolios,
  trashPortfolio,
  updateNote,
} from "@/server/vault";
import { grantWorkspaceFolders, workspaceByOwner } from "@/server/workspace";
import {
  assembleView,
  cleanRef,
  createRefusal,
  describeOwnDoc,
  matchDocs,
  matchFolders,
  takeVisible,
  writeRefusal,
  type AiDoc,
  type AiFolder,
  type Assembled,
  type ShareSlice,
  type VaultCaps,
} from "./access.ts";

/**
 * Per-response authorized corpus includes personal, shared and workspace content. Recheck every
 * write through editableTarget/uploadTarget; the response snapshot alone is insufficient.
 */

const LIST_CAP = 100;
const SEARCH_CAP = 30;

/** Reserve room for shared results when owned content fills the list limit. */
function mixDocs(docs: AiDoc[], cap: number): AiDoc[] {
  const own = docs.filter((doc) => doc.source === "propio");
  const shared = docs.filter((doc) => doc.source !== "propio");
  if (shared.length === 0 || own.length + shared.length <= cap) return docs.slice(0, cap);
  const sharedShown = shared.slice(0, Math.min(shared.length, 40));
  return [...own.slice(0, cap - sharedShown.length), ...sharedShown];
}

export type ToolResult = {
  result: unknown;
  event: { label: string; ok: boolean; docId?: string; changed?: boolean };
};

type Opened = { ownerId: string; document: Document };

function showDoc(doc: AiDoc, snippet = "") {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    place: doc.place,
    source: doc.source,
    access: doc.access,
    ...(doc.fileName ? { file: doc.fileName } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

function showFolder(folder: AiFolder) {
  return {
    id: folder.id ?? "root",
    name: folder.name,
    path: folder.path,
    place: folder.place,
    source: folder.source,
    access: folder.access,
  };
}

function fail(label: string, result: unknown): ToolResult {
  return { result, event: { label, ok: false } };
}

function pageList(pages: number[]): string {
  if (pages.length <= 1) return pages.join("");
  return `${pages.slice(0, -1).join(", ")} y ${pages[pages.length - 1]}`;
}

/** Spanish explanation when a PDF phrase cannot become an anchor. */
function phraseError(location: Exclude<PhraseLocation, { ok: true }>, phrase: string): string {
  switch (location.error) {
    case "empty":
      return "Escribe la frase o la palabra del PDF.";
    case "too-long":
      return `La frase puede tener hasta ${MAX_EXACT} caracteres.`;
    case "no-text":
      return "Ese PDF no tiene texto que se pueda vincular (puede ser un escaneo).";
    case "bad-page":
      return location.total > 0
        ? `Esa página no existe. El PDF tiene ${location.total} páginas.`
        : "Esa página no existe en el PDF.";
    case "missing-page":
      return `No encontré «${phrase}» en la página ${location.page}.`;
    case "missing":
      return `No encontré «${phrase}» en el PDF.`;
    case "ambiguous":
      return `Esa frase está en las páginas ${pageList(location.pages)}. Indica page con una de ellas.`;
  }
}

function ownInput(doc: {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  fileName: string | null;
}) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    portfolioId: doc.portfolioId,
    fileName: doc.fileName,
  };
}

async function load(sql: Sql, userId: string, caps: VaultCaps): Promise<Assembled> {
  const [ownPortfolios, ownDocs, shares] = await Promise.all([
    listPortfolios(sql, userId),
    listDocs(sql, userId, { limit: 500 }),
    sharedWith(sql, userId),
  ]);
  const slices: ShareSlice[] = [];
  for (const share of shares) {
    const response = await sharedTreeForUser(sql, userId, share.id, false);
    if (!response) continue;
    let tree: ReturnType<typeof unpackTree>;
    try {
      tree = unpackTree({ share: response.share, body: response.body() });
    } catch {
      continue;
    }
    slices.push({
      shareId: share.id,
      ownerId: share.ownerId,
      ownerName: share.ownerName,
      title: tree.share.title || share.title,
      access: tree.share.access,
      workspace: Boolean(tree.share.workspace),
      ...(tree.share.folderAccess ? { folderAccess: tree.share.folderAccess } : {}),
      portfolios: tree.portfolios,
      documents: tree.documents.map((doc) => ({
        id: doc.id,
        title: doc.title,
        kind: doc.kind,
        portfolioId: doc.portfolioId,
        fileName: doc.file?.name ?? null,
      })),
    });
  }
  return assembleView({
    userId,
    caps,
    ownPortfolios,
    ownDocs: ownDocs.map(ownInput),
    shares: slices,
  });
}

type Found = { doc: AiDoc; snippet: string };

function remember(found: Map<string, Found>, doc: AiDoc, snippet = ""): void {
  const key = `${doc.ownerId}:${doc.id}`;
  const current = found.get(key);
  if (!current) found.set(key, { doc, snippet });
  else if (!current.snippet && snippet) current.snippet = snippet;
}

/**
 * Search titles and indexed note/cell/file text. Expose only visible documents, plus owned
 * notes omitted by the preload limit.
 */
async function searchDocs(
  sql: Sql,
  userId: string,
  view: Assembled,
  caps: VaultCaps,
  query: string,
): Promise<Found[]> {
  const found = new Map<string, Found>();
  const owners = new Set<string>([userId]);
  for (const doc of view.docs) owners.add(doc.ownerId);
  for (const ownerId of owners) {
    const hits = await queryContent(sql, ownerId, query);
    for (const hit of hits) {
      const known = view.docs.find((doc) => doc.ownerId === ownerId && doc.id === hit.id);
      if (known) remember(found, known, hit.snippet);
      else if (ownerId === userId) {
        remember(
          found,
          describeOwnDoc(userId, caps, view.folders, {
            id: hit.id,
            title: hit.title,
            kind: hit.kind,
            portfolioId: hit.portfolioId,
            fileName: null,
          }),
          hit.snippet,
        );
      }
    }
  }
  const own = await listDocs(sql, userId, { query, limit: 500 });
  for (const hit of own) {
    const known = view.docs.find((doc) => doc.ownerId === userId && doc.id === hit.id);
    remember(found, known ?? describeOwnDoc(userId, caps, view.folders, ownInput(hit)));
  }
  const lower = query.trim().toLowerCase();
  for (const doc of view.docs) {
    if (doc.shareId && doc.title.toLowerCase().includes(lower)) remember(found, doc);
  }
  for (const ownerId of owners) {
    if (ownerId === userId) continue;
    const hits = await listDocs(sql, ownerId, { query, limit: 500 });
    for (const doc of takeVisible(hits, view.docs, ownerId)) remember(found, doc);
  }
  return [...found.values()];
}

/**
 * Read a visible document and recheck shared access through grantedDocOwner so mid-response
 * revocation takes effect.
 */
async function openReadable(sql: Sql, userId: string, doc: AiDoc): Promise<Opened | null> {
  if (!doc.shareId) {
    const document = await getDoc(sql, userId, doc.id);
    return document ? { ownerId: userId, document } : null;
  }
  const ownerId = await grantedDocOwner(sql, userId, doc.shareId, doc.id);
  if (!ownerId || ownerId !== doc.ownerId) return null;
  const document = await getDoc(sql, ownerId, doc.id);
  return document ? { ownerId, document } : null;
}

/** Resolve an authorized write owner; shared writes pass through editableTarget. */
async function writableOwner(sql: Sql, userId: string, doc: AiDoc): Promise<string | null> {
  if (writeRefusal(doc)) return null;
  if (!doc.shareId) return (await getDoc(sql, userId, doc.id)) ? userId : null;
  const target = await editableTarget(sql, userId, doc.shareId, doc.id);
  if (!target || target.ownerId !== doc.ownerId) return null;
  return target.ownerId;
}

export function openCorpus(sql: Sql, userId: string, caps: VaultCaps, actor: string) {
  let current: Assembled | null = null;
  const view = async (): Promise<Assembled> => {
    if (!current) current = await load(sql, userId, caps);
    return current;
  };
  const invalidate = () => {
    current = null;
  };

  const resolveDoc = async (seen: Assembled, ref: string) => {
    const key = cleanRef(ref);
    if (!key) return { status: "none" as const };
    const byId = seen.docs.filter((doc) => doc.id === key);
    const own = await getDoc(sql, userId, key);
    if (own && !byId.some((doc) => doc.shareId === null && doc.id === own.id)) {
      byId.push(
        describeOwnDoc(userId, caps, seen.folders, {
          id: own.id,
          title: own.title,
          kind: own.kind,
          portfolioId: own.portfolioId,
          fileName: own.file?.name ?? null,
        }),
      );
    }
    if (byId.length > 0) return matchDocs(byId, key);
    const ownHits = await listDocs(sql, userId, { query: key, limit: 500 });
    const pool: AiDoc[] = [];
    for (const hit of ownHits) {
      pool.push(
        seen.docs.find((doc) => doc.ownerId === userId && doc.id === hit.id) ??
          describeOwnDoc(userId, caps, seen.folders, ownInput(hit)),
      );
    }
    for (const doc of seen.docs) {
      if (doc.shareId && doc.title.toLowerCase().includes(key.toLowerCase())) pool.push(doc);
    }
    return matchDocs(pool, key);
  };

  const notFound = (seen: Assembled, ref: string, label: string): ToolResult => {
    const key = cleanRef(ref).toLowerCase();
    const similar = key
      ? seen.docs.filter((doc) => doc.title.toLowerCase().includes(key)).slice(0, 8)
      : [];
    return fail(label, {
      error: "No lo encontré entre lo que puedes abrir.",
      ...(similar.length ? { similar: similar.map((doc) => showDoc(doc)) } : {}),
    });
  };

  const pickDoc = async (ref: string, label: string): Promise<{ doc: AiDoc } | ToolResult> => {
    const seen = await view();
    const match = await resolveDoc(seen, ref);
    if (match.status === "one") return { doc: match.doc };
    if (match.status === "choices") {
      return fail(label, {
        error: "Hay varios. Usa el id de uno de estos:",
        matches: match.docs.map((doc) => showDoc(doc)),
      });
    }
    return notFound(seen, ref, label);
  };

  const pickFolder = async (
    ref: string,
    label: string,
  ): Promise<{ folder: AiFolder } | ToolResult> => {
    const seen = await view();
    const match = cleanRef(ref) ? matchFolders(seen.folders, ref) : { status: "missing" as const };
    if (match.status === "missing") {
      const root = seen.folders.find((folder) => folder.shareId === null && folder.id === null);
      return root ? { folder: root } : fail(label, { error: "No encontré la Carpeta Personal." });
    }
    if (match.status === "one") return { folder: match.folder };
    if (match.status === "choices") {
      return fail(label, {
        error: "Hay varios portafolios con ese nombre. Usa el id de uno de estos:",
        portfolios: match.folders.map(showFolder),
      });
    }
    return fail(label, {
      error: "Ese portafolio no está entre los que puedes abrir.",
      portfolios: seen.folders.slice(0, 40).map(showFolder),
    });
  };

  return {
    invalidate,
    async listPortfolios(): Promise<ToolResult> {
      const seen = await view();
      return {
        result: seen.folders.map(showFolder),
        event: { label: `Revisó ${seen.folders.length} portafolios`, ok: true },
      };
    },
    async listNotes(input: { portfolio?: string; query?: string }): Promise<ToolResult> {
      const seen = await view();
      const portfolio = input.portfolio?.trim() ?? "";
      let scope: { ownerId: string; portfolioId: string | null } | null = null;
      if (portfolio) {
        const picked = await pickFolder(portfolio, "No encontró el portafolio");
        if (!("folder" in picked)) return picked;
        scope = { ownerId: picked.folder.ownerId, portfolioId: picked.folder.id };
      }
      const inScope = (doc: AiDoc) =>
        !scope || (doc.ownerId === scope.ownerId && doc.portfolioId === scope.portfolioId);
      const query = input.query?.trim() ?? "";
      // Text search also reaches owned notes beyond the 500-item preload and indexed file contents. Without a query, list the access-filtered snapshot.
      const found = query
        ? (await searchDocs(sql, userId, seen, caps, query)).filter((item) => inScope(item.doc))
        : null;
      const docs = found ? found.map((item) => item.doc) : seen.docs.filter(inScope);
      const snippets = new Map(
        (found ?? []).map((item) => [`${item.doc.ownerId}:${item.doc.id}`, item.snippet]),
      );
      // Without a specific portfolio, prevent a large personal vault from hiding shared content.
      const shown = scope ? docs.slice(0, LIST_CAP) : mixDocs(docs, LIST_CAP);
      return {
        result: {
          documents: shown.map((doc) =>
            showDoc(doc, snippets.get(`${doc.ownerId}:${doc.id}`) ?? ""),
          ),
          ...(docs.length > LIST_CAP ? { truncated: true, total: docs.length } : {}),
        },
        event: { label: `Listó ${shown.length} documentos`, ok: true },
      };
    },
    async searchNotes(query: string): Promise<ToolResult> {
      const text = query.trim();
      if (!text) return fail("Faltó el texto", { error: "Escribe qué buscar." });
      const seen = await view();
      const found = await searchDocs(sql, userId, seen, caps, text);
      const shown = found.slice(0, SEARCH_CAP);
      return {
        result: {
          documents: shown.map((item) => showDoc(item.doc, item.snippet)),
          ...(found.length > SEARCH_CAP ? { truncated: true, total: found.length } : {}),
        },
        event: { label: `Buscó «${text}» (${shown.length})`, ok: true },
      };
    },
    async readNote(ref: string, offset = 0): Promise<ToolResult> {
      const picked = await pickDoc(ref, "No encontró el documento");
      if (!("doc" in picked)) return picked;
      if (picked.doc.fileName && isTableName(picked.doc.fileName)) {
        return fail("Es una tabla", {
          error: "Eso es una tabla. Usa query_table para ver filas, no leas el archivo entero.",
          ...showDoc(picked.doc),
        });
      }
      const opened = await openReadable(sql, userId, picked.doc);
      if (!opened)
        return fail("No encontró el documento", {
          error: "No lo encontré entre lo que puedes abrir.",
        });
      const { document } = opened;
      let source: "nota" | "índice" | "extracción" = "nota";
      let text = "";
      let indexCapped = false;
      if (document.kind === "markdown") text = document.content;
      else {
        const indexed = await indexedBody(sql, opened.ownerId, document.id);
        if (indexed) {
          text = indexed;
          source = "índice";
          indexCapped = indexed.length >= INDEX_CAP;
        } else {
          text =
            (await fileText(sql, document, INDEX_CAP)) ??
            `(archivo ${document.file?.mime ?? ""} sin texto legible: una imagen, un PDF escaneado o un formato no soportado)`;
          source = "extracción";
          // fileText appends a marker past the cap, so a longer string is a cut extract.
          indexCapped = text.length > INDEX_CAP;
        }
      }
      const slice = readSlice(text, offset);
      return {
        result: {
          ...showDoc(picked.doc),
          updated: new Date(document.updatedAt).toISOString(),
          updated_by: document.updatedBy,
          source,
          ...slice,
          ...(indexCapped ? { index_capped: true } : {}),
          ...(slice.truncated ? { next_offset: slice.offset + slice.content.length } : {}),
        },
        event: { label: `Leyó «${document.title}»`, ok: true, docId: document.id },
      };
    },
    async createNote(input: {
      title: string;
      content: string;
      portfolio?: string;
    }): Promise<ToolResult> {
      if (!caps.createNotes)
        return fail("No puede crear notas", { error: "No puedes crear notas." });
      const picked = await pickFolder(input.portfolio ?? "", "No encontró el portafolio");
      if (!("folder" in picked)) return picked;
      const refused = createRefusal(picked.folder);
      if (refused) return fail("No puede crear ahí", { error: refused });
      const title = input.title;
      const content = input.content;
      const saved = picked.folder.shareId
        ? await createShared(picked.folder, async (ownerId, portfolioId) =>
            saveNote(sql, ownerId, { title, content, portfolioId, actor }),
          )
        : await saveNote(sql, userId, { title, content, portfolioId: picked.folder.id, actor });
      if (typeof saved === "string") return fail("No puede crear ahí", { error: saved });
      invalidate();
      return {
        result: {
          id: saved.id,
          title: saved.title,
          place: picked.folder.place,
          access: "edición" as const,
        },
        event: { label: `Creó «${saved.title}»`, ok: true, docId: saved.id, changed: true },
      };
    },
    async updateNote(input: {
      ref: string;
      content?: string;
      append?: boolean;
      title?: string;
    }): Promise<ToolResult> {
      if (!caps.editNotes) return fail("No puede editar", { error: "No puedes editar notas." });
      const picked = await pickDoc(input.ref, "No encontró la nota");
      if (!("doc" in picked)) return picked;
      const refused = writeRefusal(picked.doc);
      if (refused) return fail("No puede editarlo", { error: refused });
      const ownerId = await writableOwner(sql, userId, picked.doc);
      if (!ownerId) return fail("No puede editarlo", { error: "Ya no puedes editarlo." });
      const currentDoc = await getDoc(sql, ownerId, picked.doc.id);
      if (!currentDoc)
        return fail("No encontró la nota", { error: "No lo encontré entre lo que puedes abrir." });
      const content =
        input.content === undefined
          ? undefined
          : input.append
            ? `${currentDoc.content.trimEnd()}\n\n${input.content}`
            : input.content;
      const saved = await updateNote(sql, ownerId, picked.doc.id, {
        content,
        title: input.title?.trim() || undefined,
        actor,
        actorId: userId,
      });
      invalidate();
      return {
        result: {
          id: saved.id,
          title: saved.title,
          place: picked.doc.place,
          access: picked.doc.access,
        },
        event: { label: `Editó «${saved.title}»`, ok: true, docId: saved.id, changed: true },
      };
    },
    async createPortfolio(input: { name: string; parent?: string }): Promise<ToolResult> {
      if (!caps.managePortfolios)
        return fail("No puede crear portafolios", { error: "No puedes crear portafolios." });
      const picked = await pickFolder(input.parent ?? "", "No encontró el portafolio padre");
      if (!("folder" in picked)) return picked;
      const refused = createRefusal(picked.folder);
      if (refused) return fail("No puede crear ahí", { error: refused });
      const saved = picked.folder.shareId
        ? await createShared(picked.folder, async (ownerId, portfolioId) => {
            const portfolio = await savePortfolio(sql, ownerId, {
              name: input.name,
              parentId: portfolioId,
            });
            const share = await shareForUser(sql, userId, picked.folder.shareId ?? "");
            if (share && share.access !== "admin" && share.access !== "edit") {
              const workspace = await workspaceByOwner(sql, ownerId);
              if (workspace)
                await grantWorkspaceFolders(sql, ownerId, [portfolio.id], userId, "edit");
            }
            return portfolio;
          })
        : await savePortfolio(sql, userId, { name: input.name, parentId: picked.folder.id });
      if (typeof saved === "string") return fail("No puede crear ahí", { error: saved });
      invalidate();
      return {
        result: {
          id: saved.id,
          name: saved.name,
          place: picked.folder.place,
          note: "Para crear notas dentro, usa este id en portfolio_id.",
        },
        event: { label: `Creó el portafolio «${saved.name}»`, ok: true, changed: true },
      };
    },
    async queryTable(input: { ref: string; query?: string; limit?: number }): Promise<ToolResult> {
      const picked = await pickDoc(input.ref, "No encontró la tabla");
      if (!("doc" in picked)) return picked;
      if (!picked.doc.fileName || !isTableName(picked.doc.fileName)) {
        return fail("No encontró la tabla", {
          error: "Eso no es una tabla (.tabla).",
          ...showDoc(picked.doc),
        });
      }
      const opened = await openReadable(sql, userId, picked.doc);
      if (!opened)
        return fail("No encontró la tabla", { error: "No lo encontré entre lo que puedes abrir." });
      const limit = Math.min(40, Math.max(1, Number(input.limit) || 20));
      const found = await queryRows(sql, opened.ownerId, picked.doc.id, input.query ?? "", limit);
      return {
        result: { ...showDoc(picked.doc), ...(found ?? { fields: [], rows: [] }) },
        event: { label: `Consultó «${picked.doc.title}»`, ok: true, docId: picked.doc.id },
      };
    },
    async addTableRow(input: { ref: string; cells: Record<string, unknown> }): Promise<ToolResult> {
      const picked = await pickTable(input.ref, true);
      if (!("doc" in picked)) return picked;
      const ownerId = await writableOwner(sql, userId, picked.doc);
      if (!ownerId)
        return fail("No puede editarlo", {
          error: writeRefusal(picked.doc) ?? "Ya no puedes editarlo.",
        });
      const created = await addNamedRow(sql, ownerId, picked.doc.id, input.cells, actor);
      if (!created.ok) return fail(created.error, created);
      invalidate();
      return {
        result: { id: picked.doc.id, title: picked.doc.title, rowId: created.row.id },
        event: {
          label: `Añadió una fila a «${picked.doc.title}»`,
          ok: true,
          docId: picked.doc.id,
          changed: true,
        },
      };
    },
    async setTableCell(input: {
      ref: string;
      rowId: string;
      column: string;
      value: unknown;
    }): Promise<ToolResult> {
      const picked = await pickTable(input.ref, true);
      if (!("doc" in picked)) return picked;
      const ownerId = await writableOwner(sql, userId, picked.doc);
      if (!ownerId)
        return fail("No puede editarlo", {
          error: writeRefusal(picked.doc) ?? "Ya no puedes editarlo.",
        });
      const fields = await readFields(sql, ownerId, picked.doc.id);
      const column = input.column.trim().toLowerCase();
      const field = fields.find(
        (item) => item.name.trim().toLowerCase() === column || item.id === input.column,
      );
      if (!field)
        return fail("No encontró la columna", {
          error: "Esa columna no existe.",
          columns: fields.map((item) => item.name),
        });
      const saved = await updateCell(
        sql,
        ownerId,
        picked.doc.id,
        { rowId: input.rowId, fieldId: field.id, value: input.value ?? null },
        actor,
      );
      if (!saved.ok) return fail(saved.error, saved);
      invalidate();
      return {
        result: { id: picked.doc.id, title: picked.doc.title, rowId: saved.row.id },
        event: {
          label: `Editó «${picked.doc.title}»`,
          ok: true,
          docId: picked.doc.id,
          changed: true,
        },
      };
    },
    async linkPdfPhrase(input: {
      pdf: string;
      phrase: string;
      target: string;
      page?: number;
      kind: ManualKind;
    }): Promise<ToolResult> {
      const phrase = input.phrase.trim();
      if (!phrase) return fail("No vinculó", { error: "Escribe la frase o la palabra del PDF." });
      if (phrase.length > MAX_EXACT) {
        return fail("No vinculó", { error: `La frase puede tener hasta ${MAX_EXACT} caracteres.` });
      }
      const sourcePick = await pickDoc(input.pdf, "No encontró el PDF");
      if (!("doc" in sourcePick)) return sourcePick;
      const source = sourcePick.doc;
      const refused = writeRefusal(source);
      if (refused) return fail("No puede vincularlo", { error: refused });
      const ownerId = await writableOwner(sql, userId, source);
      if (!ownerId) return fail("No puede vincularlo", { error: "Ya no puedes editarlo." });
      const opened = await openReadable(sql, userId, source);
      const file = opened?.document.file;
      if (!opened || !file || !isPdfFile(file.name, file.mime)) {
        return fail("No es un PDF", {
          error:
            "Solo se puede vincular una frase dentro de un PDF. Para notas, usa [[Título]] en la nota.",
        });
      }
      const targetPick = await pickDoc(input.target, "No encontró el destino");
      if (!("doc" in targetPick)) return targetPick;
      const target = targetPick.doc;
      if (target.id === source.id) {
        return fail("No vinculó", { error: "Un documento no se vincula consigo mismo." });
      }
      if (source.shareId && target.shareId !== source.shareId) {
        return fail("No vinculó", { error: "Ese destino no está en este espacio." });
      }
      const pages = await documentPdfPages(sql, opened.document);
      if (!pages) {
        return fail("No vinculó", {
          error: "Ese PDF no tiene texto que se pueda vincular (puede ser un escaneo).",
        });
      }
      const located = locatePhrase(pages, phrase, input.page);
      if (!located.ok) return fail("No vinculó", { error: phraseError(located, phrase) });
      const anchor = located.anchor;
      if (source.shareId) {
        const saved = await changeSharedLink(sql, {
          userId,
          actor,
          canLink: true,
          shareId: source.shareId,
          docId: source.id,
          add: { targetId: target.id, kind: input.kind, anchor },
        });
        if (!saved.ok) return fail("No vinculó", { error: saved.error });
      } else {
        const link: ManualLink = {
          targetId: target.id,
          kind: input.kind,
          anchor,
          ...(target.shareId ? { shareId: target.shareId } : {}),
        };
        const saved = await attachManualLink(sql, ownerId, source.id, link, actor);
        if (!saved.ok) return fail("No vinculó", { error: saved.error });
      }
      invalidate();
      return {
        result: {
          id: source.id,
          title: source.title,
          phrase: anchor.exact,
          page: anchor.page,
          targetId: target.id,
          targetTitle: target.title,
          kind: input.kind,
        },
        event: {
          label: `Vinculó «${anchor.exact}» en «${source.title}»`,
          ok: true,
          docId: source.id,
          changed: true,
        },
      };
    },
    async deleteDocument(
      ref: string,
      kind: "markdown" | "file",
      question: string,
    ): Promise<ToolResult> {
      const picked = await pickDoc(
        ref,
        kind === "file" ? "No encontró el archivo" : "No encontró la nota",
      );
      if (!("doc" in picked)) return picked;
      const doc = picked.doc;
      if (doc.kind !== kind) {
        return fail("No eliminó", {
          error:
            doc.kind === "file"
              ? "Eso es un archivo. Usa delete_file."
              : "Eso es una nota. Usa delete_note.",
        });
      }
      if (!namedInQuestion(question, doc.title)) return unconfirmed(doc.title);
      if (doc.shareId) {
        const share = await shareForUser(sql, userId, doc.shareId);
        if (!share || share.kind !== "portfolio")
          return fail("No eliminó", { error: "No puedes eliminar aquí." });
        if (
          !doc.portfolioId ||
          !(await subtree(sql, share.ownerId, share.targetId)).includes(doc.portfolioId)
        ) {
          return fail("No eliminó", { error: "Ese documento no es parte de lo compartido." });
        }
        if (!(await mayWriteInPortfolio(sql, share, userId, doc.portfolioId)))
          return fail("No eliminó", { error: "No puedes eliminar aquí." });
        await deleteDoc(sql, share.ownerId, doc.id);
      } else {
        if (!(await getDoc(sql, userId, doc.id)))
          return fail("No encontró el documento", { error: "Ya no está." });
        await deleteDoc(sql, userId, doc.id);
      }
      invalidate();
      return {
        result: {
          id: doc.id,
          title: doc.title,
          kind: doc.kind,
          place: doc.place,
          trash: true,
        },
        event: {
          label: `Eliminó «${doc.title}»`,
          ok: true,
          docId: doc.id,
          changed: true,
        },
      };
    },
    async deletePortfolio(ref: string, question: string): Promise<ToolResult> {
      const picked = await pickFolder(ref, "No encontró el portafolio");
      if (!("folder" in picked)) return picked;
      const folder = picked.folder;
      if (!folder.id) return fail("No eliminó", { error: "La Carpeta Personal no se elimina." });
      if (!namedInQuestion(question, folder.name)) return unconfirmed(folder.name);
      let ownerId = userId;
      if (folder.shareId) {
        const share = await shareForUser(sql, userId, folder.shareId);
        if (!share || share.kind !== "portfolio")
          return fail("No eliminó", { error: "No puedes eliminar aquí." });
        const inside = await subtree(sql, share.ownerId, share.targetId);
        if (folder.id === share.targetId || !inside.includes(folder.id)) {
          return fail("No eliminó", {
            error:
              folder.id === share.targetId
                ? "Ese portafolio es la raíz de lo compartido y no se elimina."
                : "Ese portafolio no se puede eliminar aquí.",
          });
        }
        const folders = await subtree(sql, share.ownerId, folder.id);
        for (const id of folders) {
          if (!(await mayWriteInPortfolio(sql, share, userId, id)))
            return fail("No eliminó", { error: "No puedes eliminar aquí." });
        }
        ownerId = share.ownerId;
      }
      const trashed = await trashPortfolio(sql, ownerId, folder.id);
      if (!trashed) return fail("No encontró el portafolio", { error: "Ya no está." });
      invalidate();
      return {
        result: {
          id: folder.id,
          name: folder.name,
          place: folder.place,
          portfolios: trashed.portfolios,
          documents: trashed.documents,
          trash: true,
        },
        event: {
          label: `Eliminó el portafolio «${folder.name}»`,
          ok: true,
          changed: true,
        },
      };
    },
    async createDataTable(input: {
      title: string;
      portfolio?: string;
      columns?: string;
    }): Promise<ToolResult> {
      const title = input.title.trim();
      if (!title) return fail("No creó la tabla", { error: "Escribe un título." });
      const picked = await pickFolder(input.portfolio ?? "", "No encontró el portafolio");
      if (!("folder" in picked)) return picked;
      const columns = tableColumnNames(input.columns ?? "");
      const write = async (ownerId: string, portfolioId: string | null) => {
        const saved = await saveTable(sql, ownerId, { title, portfolioId, actor });
        const created: string[] = [];
        for (const name of columns) {
          const field = await saveField(sql, ownerId, saved.id, {
            id: randomUUID(),
            name,
            type: "text",
          });
          if (!field.ok) return { saved, columns: created, error: field.error };
          created.push(name);
        }
        return { saved, columns: created };
      };
      const made = picked.folder.shareId
        ? await createShared(picked.folder, write)
        : await write(userId, picked.folder.id);
      if (typeof made === "string") return fail("No puede crear ahí", { error: made });
      if ("error" in made && made.error) {
        invalidate();
        return {
          result: {
            error: made.error,
            id: made.saved.id,
            title: made.saved.title,
            columns: made.columns,
          },
          event: {
            label: "No creó la columna",
            ok: false,
            docId: made.saved.id,
            changed: true,
          },
        };
      }
      invalidate();
      return {
        result: {
          id: made.saved.id,
          title: made.saved.title,
          place: picked.folder.place,
          columns: made.columns,
        },
        event: {
          label: `Creó la tabla «${made.saved.title}»`,
          ok: true,
          docId: made.saved.id,
          changed: true,
        },
      };
    },
  };

  /** The yes was for something else: ask again about this one. */
  function unconfirmed(name: string): ToolResult {
    return fail("Pidió confirmación antes de eliminar", {
      error: `La persona no confirmó eliminar «${name}»: tu pregunta no lo nombraba. Pregunta por «${name}» con su sitio y espera su respuesta.`,
    });
  }

  async function pickTable(ref: string, writing: boolean): Promise<{ doc: AiDoc } | ToolResult> {
    const picked = await pickDoc(ref, "No encontró la tabla");
    if (!("doc" in picked)) return picked;
    if (!picked.doc.fileName || !isTableName(picked.doc.fileName)) {
      return fail("No encontró la tabla", { error: "Eso no es una tabla (.tabla)." });
    }
    if (writing) {
      const refused = writeRefusal(picked.doc);
      if (refused) return fail("No puede editarlo", { error: refused });
      if (!caps.editNotes) return fail("No puede editar", { error: "No puedes editar notas." });
    }
    return picked;
  }

  async function createShared<T>(
    folder: AiFolder,
    write: (ownerId: string, portfolioId: string | null) => Promise<T>,
  ): Promise<T | string> {
    if (!folder.shareId) return "No puedes añadir nada a ese portafolio.";
    const target = await uploadTarget(sql, userId, {
      shareId: folder.shareId,
      portfolioId: folder.id,
    });
    if (typeof target === "string") return target;
    return write(target.ownerId, target.portfolioId);
  }
}
