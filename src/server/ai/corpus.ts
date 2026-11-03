import type { Sql } from "@/lib/db";
import type { Document } from "@/domain/vault/types";
import { unpackTree } from "@/domain/share-pack";
import { isTableName } from "@/domain/vault/table";
import { fileText } from "@/server/files";
import {
  editableTarget,
  grantedDocOwner,
  sharedTreeForUser,
  sharedWith,
  shareForUser,
} from "@/server/share";
import { addNamedRow, queryRows, readFields, updateCell } from "@/server/table";
import { uploadTarget } from "@/server/upload-target";
import {
  createNote as saveNote,
  createPortfolio as savePortfolio,
  getDoc,
  listDocs,
  listPortfolios,
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
 * Lo que el asistente puede abrir en una respuesta: la bóveda propia, lo
 * compartido y los espacios, ya filtrados. Cada escritura vuelve a comprobar
 * el permiso en el servidor (`editableTarget`, `uploadTarget`); la copia de
 * esta respuesta no basta.
 */

const MAX_NOTE = 30_000;
const LIST_CAP = 100;
const SEARCH_CAP = 30;

/** Reserva sitio para lo compartido cuando la lista propia ya llena el tope. */
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

function showDoc(doc: AiDoc) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    place: doc.place,
    source: doc.source,
    access: doc.access,
    ...(doc.fileName ? { file: doc.fileName } : {}),
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

async function searchDocs(
  sql: Sql,
  userId: string,
  view: Assembled,
  caps: VaultCaps,
  query: string,
): Promise<AiDoc[]> {
  const found = new Map<string, AiDoc>();
  const add = (doc: AiDoc) => found.set(`${doc.ownerId}:${doc.id}`, doc);
  const own = await listDocs(sql, userId, { query, limit: 500 });
  for (const hit of own) {
    const known = view.docs.find((doc) => doc.ownerId === userId && doc.id === hit.id);
    add(known ?? describeOwnDoc(userId, caps, view.folders, ownInput(hit)));
  }
  const lower = query.trim().toLowerCase();
  for (const doc of view.docs) {
    if (doc.shareId && doc.title.toLowerCase().includes(lower)) add(doc);
  }
  const owners = new Set(
    view.docs.filter((doc) => doc.ownerId !== userId).map((doc) => doc.ownerId),
  );
  for (const ownerId of owners) {
    const hits = await listDocs(sql, ownerId, { query, limit: 500 });
    for (const doc of takeVisible(hits, view.docs, ownerId)) add(doc);
  }
  return [...found.values()];
}

/**
 * Abre un documento que ya está en la vista. En lo compartido, `grantedDocOwner`
 * vuelve a comprobar el permiso: si se revocó a mitad de la respuesta, no se lee.
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

/** Dueño sobre el que se puede escribir. Lo compartido pasa por `editableTarget`. */
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
      ...(similar.length ? { similar: similar.map(showDoc) } : {}),
    });
  };

  const pickDoc = async (ref: string, label: string): Promise<{ doc: AiDoc } | ToolResult> => {
    const seen = await view();
    const match = await resolveDoc(seen, ref);
    if (match.status === "one") return { doc: match.doc };
    if (match.status === "choices") {
      return fail(label, {
        error: "Hay varios. Usa el id de uno de estos:",
        matches: match.docs.map(showDoc),
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
      // Con texto, la búsqueda también alcanza notas propias que no entraron en
      // el lote de 500. Sin texto, se lista lo ya filtrado por acceso.
      const docs = query
        ? (await searchDocs(sql, userId, seen, caps, query)).filter(inScope)
        : seen.docs.filter(inScope);
      // Sin un portafolio concreto, una bóveda grande no debe tapar lo compartido.
      const shown = scope ? docs.slice(0, LIST_CAP) : mixDocs(docs, LIST_CAP);
      return {
        result: {
          documents: shown.map(showDoc),
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
          documents: shown.map(showDoc),
          ...(found.length > SEARCH_CAP ? { truncated: true, total: found.length } : {}),
        },
        event: { label: `Buscó «${text}» (${shown.length})`, ok: true },
      };
    },
    async readNote(ref: string): Promise<ToolResult> {
      const picked = await pickDoc(ref, "No encontró el documento");
      if (!("doc" in picked)) return picked;
      const opened = await openReadable(sql, userId, picked.doc);
      if (!opened)
        return fail("No encontró el documento", {
          error: "No lo encontré entre lo que puedes abrir.",
        });
      const { document } = opened;
      const body =
        document.kind === "markdown"
          ? document.content.length > MAX_NOTE
            ? `${document.content.slice(0, MAX_NOTE)}\n…(recortado)`
            : document.content
          : ((await fileText(sql, document)) ??
            `(archivo ${document.file?.mime ?? ""} sin texto legible: una imagen, un PDF escaneado o un formato no soportado)`);
      return {
        result: {
          ...showDoc(picked.doc),
          updated: new Date(document.updatedAt).toISOString(),
          updated_by: document.updatedBy,
          content: body,
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
  };

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
