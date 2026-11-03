import {
  DAV_PERSONAL,
  DAV_SHARES,
  assignSegments,
  davDepth,
  davHref,
  davPermitted,
  davShows,
  isMarkdownName,
  lockSeconds,
  lockXml,
  matchSegment,
  mimeForName,
  noteFileName,
  noteTitleFromName,
  overwriteAllowed,
  parseDavPath,
  pathFromDestination,
  presentedLock,
  propfindXml,
  proppatchXml,
  sanitizeBase,
  type DavListed,
  type DavOp,
  type DavShareGate,
  type DavWhere,
} from "@/domain/dav";
import { descendantIds } from "@/domain/vault/portfolios";
import type { Document, Portfolio } from "@/domain/vault/types";
import type { Sql } from "@/lib/db";
import type { ApiCaller } from "@/server/api";
import { recordAudit, requestIp } from "@/server/audit";
import { blockUnsafeBlob } from "@/server/clamav";
import { deleteBlob, maxUploadBytes, putBlob } from "@/server/blobs";
import { fileResponse, migrateLegacyFiles, newFileKey } from "@/server/files";
import {
  mayReadInPortfolio,
  mayWriteInPortfolio,
  shareForUser,
  sharedWith,
  type ShareAccess,
} from "@/server/share";
import { checkSpace } from "@/server/space";
import {
  MAX_CONTENT,
  VaultError,
  createNote,
  createPortfolio,
  deleteDoc,
  getDoc,
  nextRevision,
  pushChanges,
  replaceFile,
  updateNote,
} from "@/server/vault";
import { grantWorkspaceFolders, workspaceByOwner, workspaceGrants } from "@/server/workspace";
import { visibleWorkspace } from "@/domain/workspace-view";
import { davCaller } from "./auth";
import { dropLock, lockBlocks, takeLock } from "./locks";

/**
 * WebDAV en `/dav` (solo servidor). Personal es la bóveda de quien entra.
 * Compartidos es lo que puede ver, con el mismo permiso de lectura o edición
 * que en la aplicación. El rol sigue mandando (crear, subir, borrar).
 */

const ALLOW = "OPTIONS, HEAD, GET, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, LOCK, UNLOCK";

type DocHit = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  fileName: string | null;
  fileMime: string | null;
  fileKey: string | null;
  fileSize: number;
  updatedAt: number;
  bytes: number;
};

type ShareCtx = {
  shareId: string;
  ownerId: string;
  access: ShareAccess;
  rootId: string | null;
  onlyDocId: string | null;
};

type Visible = "all" | { folders: Set<string>; docsIn: Set<string> };

type FolderPlace = {
  kind: "folder";
  ownerId: string;
  portfolioId: string | null;
  share: ShareCtx | null;
  virtualDoc: boolean;
  anchored: boolean;
  name: string;
  prefix: string[];
};

type FilePlace = {
  kind: "file";
  ownerId: string;
  share: ShareCtx | null;
  doc: DocHit;
  name: string;
  prefix: string[];
};

type Place =
  | { kind: "root"; name: string; prefix: string[] }
  | { kind: "zone"; name: string; prefix: string[] }
  | FolderPlace
  | FilePlace;

type Bag = {
  sql: Sql;
  userId: string;
  profile: ApiCaller["profile"];
  actor: string;
  portfolios: Map<string, Portfolio[]>;
  visible: Map<string, Visible>;
};

const profileOf = (bag: Bag) => ({
  isAdmin: bag.profile.isAdmin,
  permissions: bag.profile.permissions,
});

function allows(bag: Bag, op: DavOp, share: DavShareGate): boolean {
  return davPermitted(op, profileOf(bag), share);
}

function plain(status: number, message: string, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    DAV: "1, 2",
    "cache-control": "no-store",
    ...extra,
  });
  return new Response(message, { status, headers });
}

function xml(status: number, body: string, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "application/xml; charset=utf-8",
    DAV: "1, 2",
    "cache-control": "no-store",
    ...extra,
  });
  return new Response(body, { status, headers });
}

function options(): Response {
  return new Response(null, {
    status: 204,
    headers: { DAV: "1, 2", Allow: ALLOW, "MS-Author-Via": "DAV", "cache-control": "no-store" },
  });
}

function hrefOf(place: Place, collection: boolean): string {
  return davHref(place.prefix, collection);
}

function presented(request: Request): string | null {
  return (
    presentedLock(request.headers.get("if")) ?? presentedLock(request.headers.get("lock-token"))
  );
}

async function audit(
  bag: Bag,
  request: Request,
  outcome: "ok" | "denied" | "error",
  detail: string,
  action = "webdav",
): Promise<void> {
  await recordAudit(bag.sql, {
    actorId: bag.userId,
    actorName: bag.actor,
    action,
    outcome,
    area: "WebDAV",
    target: new URL(request.url).pathname,
    detail,
    ip: requestIp(request),
  }).catch((error) => console.error("[dav] auditoría", error));
}

export async function handleDav(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return options();
  try {
    const caller = await davCaller(request);
    if (caller instanceof Response) return caller;
    const bag: Bag = {
      sql: caller.sql,
      userId: caller.userId,
      profile: caller.profile,
      actor: caller.profile.displayName || caller.profile.loginName || "WebDAV",
      portfolios: new Map(),
      visible: new Map(),
    };
    return await dispatch(bag, request, method);
  } catch (error) {
    if (error instanceof VaultError) return plain(error.status, error.message);
    console.error("[dav]", error);
    return plain(500, "Error interno.");
  }
}

async function dispatch(bag: Bag, request: Request, method: string): Promise<Response> {
  const where = parseDavPath(new URL(request.url).pathname);
  if (where.kind === "bad") return plain(404, "No está.");
  if (method === "PROPFIND") return propfind(bag, request, where);
  if (method === "PROPPATCH") return proppatch(bag, request, where);
  if (method === "GET" || method === "HEAD") return readOne(bag, request, where, method === "HEAD");
  if (method === "PUT") return putOne(bag, request, where);
  if (method === "DELETE") return deleteOne(bag, request, where);
  if (method === "MKCOL") return mkcol(bag, request, where);
  if (method === "MOVE") return moveOne(bag, request, where);
  if (method === "LOCK") return lockOne(bag, request, where);
  if (method === "UNLOCK") return unlockOne(bag, request, where);
  return plain(405, "Método no admitido.", { Allow: ALLOW });
}

async function propfind(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const depth = davDepth(request.headers.get("depth"));
  if ("reject" in depth) return plain(403, "Depth infinity no está soportado. Usa Depth: 1.");
  if (!allows(bag, "list", null)) return deny(bag, request, "Tu rol no puede listar la bóveda.");
  const place = await locate(bag, where);
  if (!place) return plain(404, "No está.");
  const self = describe(place);
  const items: DavListed[] = [self];
  if (depth.depth === 1 && self.collection) {
    for (const child of await children(bag, place)) items.push(describe(child));
  }
  return xml(207, propfindXml(items));
}

function describe(place: Place): DavListed {
  if (place.kind === "file") {
    const bytes = place.doc.kind === "markdown" ? place.doc.bytes : place.doc.fileSize;
    const mime =
      place.doc.kind === "markdown"
        ? "text/markdown; charset=utf-8"
        : place.doc.fileMime || "application/octet-stream";
    return {
      href: hrefOf(place, false),
      name: place.name,
      collection: false,
      bytes,
      mime,
      modifiedMs: place.doc.updatedAt,
    };
  }
  const collection = true;
  return {
    href: hrefOf(place, collection),
    name: place.name,
    collection,
    bytes: null,
    mime: "",
    modifiedMs: 0,
  };
}

async function proppatch(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const place = await locate(bag, where);
  if (!place) return plain(404, "No está.");
  const body = await request.text();
  // Las propiedades no se guardan: el cliente solo necesita seguir.
  return xml(207, proppatchXml(hrefOf(place, place.kind !== "file"), body.slice(0, 100_000)));
}

async function readOne(
  bag: Bag,
  request: Request,
  where: DavWhere,
  head: boolean,
): Promise<Response> {
  const place = await locate(bag, where);
  if (!place) return plain(404, "No está.");
  if (place.kind !== "file") return plain(405, "Es una carpeta.", { Allow: "PROPFIND, OPTIONS" });
  const op: DavOp = place.doc.kind === "markdown" ? "read-note" : "read-file";
  const share = await shareGate(bag, place.share, place.doc.portfolioId, false);
  if (!allows(bag, op, share)) return deny(bag, request, "Tu rol no puede leer eso.");
  if (place.doc.kind === "markdown") {
    const text = await noteContent(bag.sql, place.ownerId, place.doc.id);
    if (text === null) return plain(404, "No está.");
    const headers: Record<string, string> = {
      "content-type": "text/markdown; charset=utf-8",
      "content-length": String(Buffer.byteLength(text)),
      DAV: "1, 2",
      "cache-control": "no-store",
    };
    return new Response(head ? null : text, { status: 200, headers });
  }
  if (!place.doc.fileKey) return plain(404, "El archivo no está en el almacén.");
  if (head) {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": place.doc.fileMime || "application/octet-stream",
        "content-length": String(place.doc.fileSize),
        DAV: "1, 2",
        "cache-control": "no-store",
      },
    });
  }
  const response = await fileResponse(
    bag.sql,
    {
      name: place.doc.fileName || place.name,
      mime: place.doc.fileMime || "application/octet-stream",
      key: place.doc.fileKey,
    },
    { download: false, range: request.headers.get("range") },
  );
  if (!response) return plain(404, "El archivo no está en el almacén.");
  response.headers.set("DAV", "1, 2");
  return response;
}

async function putOne(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const tail = splitTail(where);
  if (!tail) return plain(405, "Ahí no se puede guardar.", { Allow: "PROPFIND, OPTIONS" });
  const parent = await locate(bag, tail.parent);
  if (!parent || parent.kind !== "folder") return plain(409, "La carpeta no existe.");
  const existing = await locate(bag, where);
  // La carpeta de un documento compartido no admite vecinos: solo reemplazar ese archivo.
  if (parent.virtualDoc && existing?.kind !== "file")
    return deny(bag, request, "Ahí solo está el documento compartido.");
  const href = davHref([...parent.prefix, tail.name], false);
  if (lockBlocks(href, presented(request))) return plain(423, "Bloqueado.");
  const bytes = await readLimited(request);
  if (bytes instanceof Response) return bytes;
  if (existing && existing.kind === "folder") return plain(409, "Ahí hay una carpeta.");
  if (existing && existing.kind !== "file") return plain(409, "Ahí no se puede guardar.");
  if (existing?.kind === "file") {
    if (!overwriteAllowed(request.headers.get("overwrite"))) return plain(412, "Ya existe.");
    return existing.doc.kind === "markdown"
      ? writeNote(bag, request, existing, bytes, false)
      : writeFile(bag, request, parent, tail.name, bytes, existing);
  }
  if (isMarkdownName(tail.name)) return writeNote(bag, request, parent, bytes, true, tail.name);
  return writeFile(bag, request, parent, tail.name, bytes, null);
}

async function writeNote(
  bag: Bag,
  request: Request,
  target: FolderPlace | FilePlace,
  bytes: Uint8Array,
  creating: boolean,
  name = "",
): Promise<Response> {
  const folder = target.kind === "folder" ? target : null;
  const current = target.kind === "file" ? target : null;
  const ownerId = target.ownerId;
  const portfolioId = folder ? folder.portfolioId : current!.doc.portfolioId;
  const share = target.share;
  const op: DavOp = creating ? "create-note" : "edit-note";
  const gate = await shareGate(bag, share, portfolioId, true);
  if (!allows(bag, op, gate)) return deny(bag, request, "No puedes modificar esa nota.");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.length > MAX_CONTENT) return plain(413, "La nota es demasiado larga.");
  if (creating && folder) {
    const title = noteTitleFromName(name);
    if (!(await titleFree(bag.sql, ownerId, title)))
      return plain(409, "Ya hay una nota con ese título.");
    await createNote(bag.sql, ownerId, { title, content: text, portfolioId, actor: bag.actor });
    await audit(bag, request, "ok", "Crea una nota");
    return plain(201, "Creada.");
  }
  if (!current) return plain(404, "No está.");
  const title = noteTitleFromName(current.name);
  if (title !== current.doc.title && !(await titleFree(bag.sql, ownerId, title, current.doc.id))) {
    return plain(409, "Ya hay una nota con ese título.");
  }
  await updateNote(bag.sql, ownerId, current.doc.id, {
    content: text,
    ...(title !== current.doc.title ? { title } : {}),
    actor: bag.actor,
    actorId: bag.userId,
  });
  await audit(bag, request, "ok", "Actualiza una nota");
  return plain(204, "");
}

async function writeFile(
  bag: Bag,
  request: Request,
  parent: FolderPlace,
  name: string,
  bytes: Uint8Array,
  existing: FilePlace | null,
): Promise<Response> {
  const portfolioId = existing ? existing.doc.portfolioId : parent.portfolioId;
  const ownerId = existing ? existing.ownerId : parent.ownerId;
  const share = existing ? existing.share : parent.share;
  const gate = await shareGate(bag, share, portfolioId, true);
  if (!allows(bag, "upload-file", gate)) return deny(bag, request, "No puedes subir ahí.");
  const extra = existing ? Math.max(0, bytes.byteLength - existing.doc.fileSize) : bytes.byteLength;
  const full = await checkSpace(bag.sql, {
    ownerId,
    portfolioId,
    uploaderId: bag.userId,
    bytes: extra,
  });
  if (full) return plain(413, full);
  const mime = mimeForName(name, request.headers.get("content-type"));
  const key = newFileKey(ownerId);
  await putBlob(bag.sql, key, bytes, mime);
  const blocked = await blockUnsafeBlob(bag.sql, key);
  if (blocked) {
    await audit(bag, request, "denied", blocked.signature || blocked.detail, "virus");
    return plain(blocked.status, blocked.message);
  }
  let committed = false;
  try {
    if (existing) {
      await migrateLegacyFiles(bag.sql, ownerId, () => nextRevision(bag.sql, ownerId));
      const current = await getDoc(bag.sql, ownerId, existing.doc.id);
      if (current?.file?.key) {
        await replaceFile(bag.sql, ownerId, existing.doc.id, {
          key,
          size: bytes.byteLength,
          actor: bag.actor,
          actorId: bag.userId,
        });
        committed = true;
        if (name !== (current.file?.name ?? "")) {
          await renameStoredFile(bag.sql, ownerId, existing.doc.id, name, bag.actor);
        }
      } else {
        await setFileKey(bag.sql, ownerId, existing.doc.id, {
          key,
          size: bytes.byteLength,
          name,
          mime,
          actor: bag.actor,
        });
        committed = true;
      }
    } else {
      const id = crypto.randomUUID();
      const now = Date.now();
      const doc: Document = {
        id,
        title: noteTitleFromName(name).slice(0, 200),
        kind: "file",
        portfolioId,
        content: "",
        file: { name, mime, key, size: bytes.byteLength },
        links: [],
        pinned: false,
        createdAt: now,
        updatedAt: now,
        createdBy: bag.actor,
        updatedBy: bag.actor,
      };
      await pushChanges(bag.sql, ownerId, {
        docs: [doc],
        deletedDocs: [],
        portfolios: [],
        deletedPortfolios: [],
      });
      if (ownerId !== bag.userId) {
        await bag.sql`update vault_doc set uploaded_by = ${bag.userId} where user_id = ${ownerId} and id = ${id}`;
      }
      committed = true;
    }
  } catch (error) {
    if (!committed) await deleteBlob(bag.sql, key).catch(() => undefined);
    throw error;
  }
  await audit(bag, request, "ok", existing ? "Sustituye un archivo" : "Sube un archivo");
  return plain(existing ? 204 : 201, existing ? "" : "Creado.");
}

async function deleteOne(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const place = await locate(bag, where);
  if (!place) return plain(404, "No está.");
  if (
    place.kind === "root" ||
    place.kind === "zone" ||
    (place.kind === "folder" && place.anchored)
  ) {
    return deny(bag, request, "Esa carpeta no se puede borrar desde aquí.");
  }
  const href = hrefOf(place, place.kind === "folder");
  if (lockBlocks(href, presented(request))) return plain(423, "Bloqueado.");
  if (place.kind === "file") {
    const op: DavOp = place.doc.kind === "markdown" ? "delete-note" : "delete-file";
    const gate = await shareGate(bag, place.share, place.doc.portfolioId, true);
    if (!allows(bag, op, gate)) return deny(bag, request, "No puedes borrar eso.");
    await deleteDoc(bag.sql, place.ownerId, place.doc.id);
    await audit(bag, request, "ok", "Borra un documento");
    return plain(204, "");
  }
  const gate = await shareGate(bag, place.share, place.portfolioId, true);
  if (!allows(bag, "manage", gate)) return deny(bag, request, "No puedes borrar esa carpeta.");
  if (!place.portfolioId) return plain(403, "Esa carpeta no se puede borrar desde aquí.");
  const portfolios = await portfoliosOf(bag, place.ownerId);
  const ids = descendantIds(portfolios, place.portfolioId);
  const docIds = await docIdsIn(bag.sql, place.ownerId, ids);
  await pushChanges(bag.sql, place.ownerId, {
    docs: [],
    deletedDocs: docIds,
    portfolios: [],
    deletedPortfolios: [...ids],
  });
  await audit(bag, request, "ok", "Borra una carpeta");
  return plain(204, "");
}

async function mkcol(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const tail = splitTail(where);
  if (!tail)
    return plain(405, "Ahí no se puede crear una carpeta.", { Allow: "PROPFIND, OPTIONS" });
  if (await locate(bag, where)) return plain(405, "Ya existe.", { Allow: "PROPFIND, OPTIONS" });
  const parent = await locate(bag, tail.parent);
  if (!parent || parent.kind !== "folder" || parent.virtualDoc)
    return plain(409, "La carpeta padre no existe.");
  const href = davHref([...parent.prefix, tail.name], true);
  if (lockBlocks(href, presented(request))) return plain(423, "Bloqueado.");
  const gate = await shareGate(bag, parent.share, parent.portfolioId, true);
  if (!allows(bag, "manage", gate)) return deny(bag, request, "No puedes crear carpetas ahí.");
  const portfolio = await createPortfolio(bag.sql, parent.ownerId, {
    name: tail.name,
    parentId: parent.portfolioId,
  });
  if (parent.share && parent.share.access !== "admin" && parent.share.access !== "edit") {
    const workspace = await workspaceByOwner(bag.sql, parent.ownerId);
    if (workspace)
      await grantWorkspaceFolders(bag.sql, parent.ownerId, [portfolio.id], bag.userId, "edit");
  }
  bag.portfolios.delete(parent.ownerId);
  await audit(bag, request, "ok", "Crea una carpeta");
  return plain(201, "Creada.");
}

async function moveOne(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const source = await locate(bag, where);
  if (!source || source.kind === "root" || source.kind === "zone") return plain(404, "No está.");
  if (source.kind === "folder" && source.anchored)
    return deny(bag, request, "Esa carpeta no se puede mover desde aquí.");
  const destPath = pathFromDestination(request.headers.get("destination"), request.url);
  const destWhere = destPath ? parseDavPath(destPath) : { kind: "bad" as const };
  if (destWhere.kind === "bad") return plain(400, "Destination no es una ruta de /dav.");
  if (samePlace(where, destWhere)) return plain(204, "");
  const tail = splitTail(destWhere);
  if (!tail) return plain(403, "No se puede mover ahí.");
  const parent = await locate(bag, tail.parent);
  if (!parent || parent.kind !== "folder") return plain(409, "La carpeta de destino no existe.");
  const renamingSharedDoc =
    parent.virtualDoc && source.kind === "file" && source.share?.onlyDocId === source.doc.id;
  if (parent.virtualDoc && !renamingSharedDoc)
    return plain(409, "La carpeta de destino no existe.");
  if (source.ownerId !== parent.ownerId)
    return deny(bag, request, "No se puede mover entre bóvedas.");
  if (source.share?.shareId !== parent.share?.shareId)
    return deny(bag, request, "Solo puedes moverlo dentro de lo mismo.");
  const destHref = davHref([...parent.prefix, tail.name], source.kind === "folder");
  if (
    lockBlocks(hrefOf(source, source.kind === "folder"), presented(request)) ||
    lockBlocks(destHref, presented(request))
  ) {
    return plain(423, "Bloqueado.");
  }
  const occupied = await locate(bag, destWhere);
  if (occupied && !overwriteAllowed(request.headers.get("overwrite")))
    return plain(412, "Ya existe.");
  if (occupied && occupied.kind === "folder") return plain(409, "El destino es una carpeta.");
  if (source.kind === "folder" && source.portfolioId) {
    const portfolios = await portfoliosOf(bag, source.ownerId);
    if (
      parent.portfolioId &&
      descendantIds(portfolios, source.portfolioId).has(parent.portfolioId)
    ) {
      return plain(409, "No se puede mover una carpeta dentro de sí misma.");
    }
  }
  const fromGate = await shareGate(
    bag,
    source.share,
    source.kind === "file" ? source.doc.portfolioId : source.portfolioId,
    true,
  );
  const toGate = await shareGate(bag, parent.share, parent.portfolioId, true);
  const op: DavOp =
    source.kind === "folder"
      ? "manage"
      : source.doc.kind === "markdown"
        ? "edit-note"
        : "upload-file";
  if (!allows(bag, op, fromGate) || !allows(bag, op, toGate))
    return deny(bag, request, "No puedes mover eso.");
  if (occupied?.kind === "file") await deleteDoc(bag.sql, occupied.ownerId, occupied.doc.id);
  if (source.kind === "folder" && source.portfolioId) {
    const name = sanitizeBase(tail.name);
    if (!name) return plain(400, "El nombre no sirve.");
    await pushChanges(bag.sql, source.ownerId, {
      docs: [],
      deletedDocs: [],
      portfolios: [{ id: source.portfolioId, name, parentId: parent.portfolioId }],
      deletedPortfolios: [],
    });
  } else if (source.kind === "file" && source.doc.kind === "markdown") {
    const title = noteTitleFromName(tail.name);
    if (!(await titleFree(bag.sql, source.ownerId, title, source.doc.id)))
      return plain(409, "Ya hay una nota con ese título.");
    await updateNote(bag.sql, source.ownerId, source.doc.id, {
      title,
      ...(parent.virtualDoc ? {} : { portfolioId: parent.portfolioId }),
      actor: bag.actor,
      actorId: bag.userId,
    });
  } else if (source.kind === "file") {
    await renameStoredFile(
      bag.sql,
      source.ownerId,
      source.doc.id,
      tail.name,
      bag.actor,
      parent.virtualDoc ? undefined : parent.portfolioId,
    );
  }
  await audit(bag, request, "ok", "Mueve");
  return plain(occupied ? 204 : 201, "");
}

async function lockOne(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  let place = await locate(bag, where);
  const seconds = lockSeconds(request.headers.get("timeout"));
  if (!place) {
    const tail = splitTail(where);
    const parent = tail ? await locate(bag, tail.parent) : null;
    if (!tail || !parent || parent.kind !== "folder" || parent.virtualDoc)
      return plain(404, "No está.");
    const op: DavOp = isMarkdownName(tail.name) ? "create-note" : "upload-file";
    const gate = await shareGate(bag, parent.share, parent.portfolioId, true);
    if (!allows(bag, op, gate)) return deny(bag, request, "No puedes crear ahí.");
    place = {
      kind: "file",
      ownerId: parent.ownerId,
      share: parent.share,
      name: tail.name,
      prefix: [...parent.prefix, tail.name],
      doc: emptyDoc(tail.name),
    };
  }
  if (place.kind === "root" || place.kind === "zone")
    return plain(405, "Eso no se bloquea.", { Allow: "PROPFIND, OPTIONS" });
  const href = hrefOf(place, place.kind === "folder");
  const taken = takeLock(href, presented(request), seconds);
  if (!taken.ok) return plain(423, "Bloqueado.");
  return xml(200, lockXml(href, taken.token, seconds), { "Lock-Token": `<${taken.token}>` });
}

async function unlockOne(bag: Bag, request: Request, where: DavWhere): Promise<Response> {
  const place = await locate(bag, where);
  const href =
    place && place.kind !== "root" && place.kind !== "zone"
      ? hrefOf(place, place.kind === "folder")
      : davHref(pathParts(where), false);
  if (!dropLock(href, presented(request))) return plain(409, "Ese bloqueo no está.");
  return plain(204, "");
}

function emptyDoc(name: string): DocHit {
  return {
    id: "",
    title: name,
    kind: "file",
    portfolioId: null,
    fileName: name,
    fileMime: null,
    fileKey: null,
    fileSize: 0,
    updatedAt: 0,
    bytes: 0,
  };
}

function pathParts(where: DavWhere): string[] {
  if (where.kind === "personal") return [DAV_PERSONAL, ...where.segments];
  if (where.kind === "shares") return [DAV_SHARES, ...where.segments];
  return [];
}

function samePlace(a: DavWhere, b: DavWhere): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function splitTail(where: DavWhere): { parent: DavWhere; name: string } | null {
  if ((where.kind !== "personal" && where.kind !== "shares") || where.segments.length === 0)
    return null;
  return {
    name: where.segments[where.segments.length - 1]!,
    parent: { kind: where.kind, segments: where.segments.slice(0, -1) },
  };
}

async function deny(bag: Bag, request: Request, detail: string): Promise<Response> {
  await audit(bag, request, "denied", detail);
  return plain(403, detail);
}

async function readLimited(request: Request): Promise<Uint8Array | Response> {
  const max = maxUploadBytes();
  const declared = Number(request.headers.get("content-length"));
  const message = `El archivo supera el límite de ${Math.round(max / (1024 * 1024))} MB.`;
  if (Number.isFinite(declared) && declared > max) return plain(413, message);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > max) return plain(413, message);
  return bytes;
}

/** `null` en la bóveda propia. En lo compartido, leer o escribir ese portafolio. */
async function shareGate(
  bag: Bag,
  share: ShareCtx | null,
  portfolioId: string | null,
  writing: boolean,
): Promise<DavShareGate> {
  if (!share) return null;
  const write = writing
    ? await mayWriteInPortfolio(
        bag.sql,
        { ownerId: share.ownerId, access: share.access },
        bag.userId,
        portfolioId,
      )
    : false;
  return { read: true, write };
}

async function locate(bag: Bag, where: DavWhere): Promise<Place | null> {
  if (where.kind === "bad") return null;
  if (where.kind === "root") return { kind: "root", name: "Grafito", prefix: [] };
  if (where.kind === "shares" && where.segments.length === 0) {
    return { kind: "zone", name: DAV_SHARES, prefix: [DAV_SHARES] };
  }
  if (where.kind === "personal" && where.segments.length === 0) {
    return {
      kind: "folder",
      ownerId: bag.userId,
      portfolioId: null,
      share: null,
      virtualDoc: false,
      anchored: true,
      name: DAV_PERSONAL,
      prefix: [DAV_PERSONAL],
    };
  }
  if (where.kind === "personal") {
    return walk(bag, bag.userId, null, where.segments, null, [DAV_PERSONAL]);
  }
  const shares = await shareNames(bag);
  const shareId = matchSegment(shares, where.segments[0] ?? "");
  if (!shareId) return null;
  const share = shares.find((item) => item.id === shareId);
  const ctx = share ? await openShare(bag, share.id) : null;
  if (!share || !ctx) return null;
  const prefix = [DAV_SHARES, share.segment];
  if (where.segments.length === 1) {
    return {
      kind: "folder",
      ownerId: ctx.ownerId,
      portfolioId: ctx.onlyDocId ? null : ctx.rootId,
      share: ctx,
      virtualDoc: ctx.onlyDocId !== null,
      anchored: true,
      name: share.segment,
      prefix,
    };
  }
  if (ctx.onlyDocId) return walkDoc(bag, ctx, where.segments.slice(1), prefix);
  return walk(bag, ctx.ownerId, ctx.rootId, where.segments.slice(1), ctx, prefix);
}

async function walk(
  bag: Bag,
  ownerId: string,
  portfolioId: string | null,
  segments: string[],
  share: ShareCtx | null,
  prefix: string[],
): Promise<Place | null> {
  if (segments.length === 0) {
    return {
      kind: "folder",
      ownerId,
      portfolioId,
      share,
      virtualDoc: false,
      anchored: false,
      name: prefix[prefix.length - 1] ?? DAV_PERSONAL,
      prefix,
    };
  }
  const listed = await folderChildren(bag, ownerId, portfolioId, share);
  const named = assignSegments(listed.map((item) => ({ id: item.id, base: item.base })));
  const id = matchSegment(named, segments[0] ?? "");
  const segment = named.find((item) => item.id === id)?.segment;
  const child = listed.find((item) => item.id === id);
  if (!id || !segment || !child) return null;
  if (child.kind === "portfolio") {
    return walk(bag, ownerId, child.id, segments.slice(1), share, [...prefix, segment]);
  }
  if (segments.length > 1 || !child.doc) return null;
  return {
    kind: "file",
    ownerId,
    share,
    doc: child.doc,
    name: segment,
    prefix: [...prefix, segment],
  };
}

async function walkDoc(
  bag: Bag,
  share: ShareCtx,
  segments: string[],
  prefix: string[],
): Promise<Place | null> {
  if (!share.onlyDocId || segments.length !== 1) return null;
  const doc = await oneDoc(bag.sql, share.ownerId, share.onlyDocId);
  if (!doc || !davShows(profileOf(bag), doc.kind)) return null;
  if (
    !(await mayReadInPortfolio(
      bag.sql,
      { ownerId: share.ownerId, access: share.access },
      bag.userId,
      doc.portfolioId,
    ))
  ) {
    return null;
  }
  const named = assignSegments([{ id: doc.id, base: baseOf(doc.kind, doc.title, doc.fileName) }]);
  if (matchSegment(named, segments[0] ?? "") !== doc.id) return null;
  return {
    kind: "file",
    ownerId: share.ownerId,
    share,
    doc,
    name: named[0]!.segment,
    prefix: [...prefix, named[0]!.segment],
  };
}

type Listed = {
  id: string;
  kind: "portfolio" | "markdown" | "file";
  base: string;
  doc: DocHit | null;
};

async function children(bag: Bag, place: Place): Promise<Place[]> {
  if (place.kind === "root") {
    return [
      {
        kind: "folder",
        ownerId: bag.userId,
        portfolioId: null,
        share: null,
        virtualDoc: false,
        anchored: true,
        name: DAV_PERSONAL,
        prefix: [DAV_PERSONAL],
      },
      { kind: "zone", name: DAV_SHARES, prefix: [DAV_SHARES] },
    ];
  }
  if (place.kind === "zone") {
    const shares = await shareNames(bag);
    return shares.map((share) => ({
      kind: "folder" as const,
      ownerId: share.ownerId,
      portfolioId: null,
      share: null,
      virtualDoc: false,
      anchored: true,
      name: share.segment,
      prefix: [DAV_SHARES, share.segment],
    }));
  }
  if (place.kind !== "folder") return [];
  const listed =
    place.virtualDoc && place.share?.onlyDocId
      ? await virtualChildren(bag, place.share)
      : await folderChildren(bag, place.ownerId, place.portfolioId, place.share);
  const named = assignSegments(listed.map((item) => ({ id: item.id, base: item.base })));
  const byId = new Map(named.map((item) => [item.id, item.segment]));
  const places: Place[] = [];
  for (const item of listed) {
    const segment = byId.get(item.id);
    if (!segment) continue;
    if (item.kind === "portfolio") {
      places.push({
        kind: "folder",
        ownerId: place.ownerId,
        portfolioId: item.id,
        share: place.share,
        virtualDoc: false,
        anchored: false,
        name: segment,
        prefix: [...place.prefix, segment],
      });
    } else if (item.doc) {
      places.push({
        kind: "file",
        ownerId: place.ownerId,
        share: place.share,
        doc: item.doc,
        name: segment,
        prefix: [...place.prefix, segment],
      });
    }
  }
  return places;
}

async function virtualChildren(bag: Bag, share: ShareCtx): Promise<Listed[]> {
  if (!share.onlyDocId) return [];
  const doc = await oneDoc(bag.sql, share.ownerId, share.onlyDocId);
  if (!doc || !davShows(profileOf(bag), doc.kind)) return [];
  if (
    !(await mayReadInPortfolio(
      bag.sql,
      { ownerId: share.ownerId, access: share.access },
      bag.userId,
      doc.portfolioId,
    ))
  )
    return [];
  return [{ id: doc.id, kind: doc.kind, base: baseOf(doc.kind, doc.title, doc.fileName), doc }];
}

async function folderChildren(
  bag: Bag,
  ownerId: string,
  portfolioId: string | null,
  share: ShareCtx | null,
): Promise<Listed[]> {
  const visible = await visibility(bag, share);
  if (
    visible !== "all" &&
    portfolioId &&
    !visible.folders.has(portfolioId) &&
    portfolioId !== share?.rootId
  )
    return [];
  const showDocs = visible === "all" || (portfolioId !== null && visible.docsIn.has(portfolioId));
  const portfolios = (await portfoliosOf(bag, ownerId)).filter(
    (item) => item.parentId === portfolioId,
  );
  const docs = showDocs ? await docsIn(bag.sql, ownerId, portfolioId) : [];
  const listed: Listed[] = [];
  for (const portfolio of portfolios) {
    if (visible !== "all" && !visible.folders.has(portfolio.id)) continue;
    if (!davShows(profileOf(bag), "portfolio")) continue;
    listed.push({
      id: portfolio.id,
      kind: "portfolio",
      base: baseOf("portfolio", portfolio.name, null),
      doc: null,
    });
  }
  for (const doc of docs) {
    if (!davShows(profileOf(bag), doc.kind)) continue;
    listed.push({
      id: doc.id,
      kind: doc.kind,
      base: baseOf(doc.kind, doc.title, doc.fileName),
      doc,
    });
  }
  return listed;
}

async function visibility(bag: Bag, share: ShareCtx | null): Promise<Visible> {
  if (!share || share.onlyDocId) return "all";
  const cached = bag.visible.get(share.shareId);
  if (cached) return cached;
  let result: Visible = "all";
  if (share.access !== "admin" && share.access !== "edit") {
    const workspace = await workspaceByOwner(bag.sql, share.ownerId);
    if (workspace) {
      const grants = await workspaceGrants(bag.sql, share.ownerId, bag.userId);
      const granted = new Set(grants.map(([id]) => id));
      const portfolios = await portfoliosOf(bag, share.ownerId);
      const visible = visibleWorkspace(workspace.root_portfolio_id, portfolios, [], granted);
      result = { folders: new Set(visible.portfolios.map((item) => item.id)), docsIn: granted };
    }
  }
  bag.visible.set(share.shareId, result);
  return result;
}

async function shareNames(bag: Bag): Promise<{ id: string; ownerId: string; segment: string }[]> {
  const rows = await sharedWith(bag.sql, bag.userId);
  const named = assignSegments(
    rows.map((row) => ({ id: row.id, base: sanitizeBase(row.title) || "compartido" })),
  );
  const segment = new Map(named.map((item) => [item.id, item.segment]));
  return rows.map((row) => ({
    id: row.id,
    ownerId: row.ownerId,
    segment: segment.get(row.id) ?? row.id.slice(0, 8),
  }));
}

async function openShare(bag: Bag, shareId: string): Promise<ShareCtx | null> {
  const share = await shareForUser(bag.sql, bag.userId, shareId);
  if (!share || share.ownerId === bag.userId) return null;
  if (share.kind === "document") {
    const doc = await oneDoc(bag.sql, share.ownerId, share.targetId);
    return {
      shareId,
      ownerId: share.ownerId,
      access: share.access,
      rootId: doc?.portfolioId ?? null,
      onlyDocId: doc?.id ?? null,
    };
  }
  return {
    shareId,
    ownerId: share.ownerId,
    access: share.access,
    rootId: share.targetId,
    onlyDocId: null,
  };
}

async function portfoliosOf(bag: Bag, ownerId: string): Promise<Portfolio[]> {
  const cached = bag.portfolios.get(ownerId);
  if (cached) return cached;
  const rows = await bag.sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from vault_portfolio where user_id = ${ownerId} and not deleted
  `;
  const portfolios = rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id }));
  bag.portfolios.set(ownerId, portfolios);
  return portfolios;
}

async function docsIn(sql: Sql, ownerId: string, portfolioId: string | null): Promise<DocHit[]> {
  const rows = await sql<{
    id: string;
    title: string;
    kind: "markdown" | "file";
    portfolio_id: string | null;
    file_name: string | null;
    file_mime: string | null;
    file_key: string | null;
    file_size: unknown;
    updated_at: unknown;
    bytes: unknown;
  }>`
    select id, title, kind, portfolio_id, file_name, file_mime, file_key, file_size, updated_at,
      octet_length(coalesce(content, '')) as bytes
    from vault_doc
    where user_id = ${ownerId} and not deleted
      and coalesce(portfolio_id, '') = coalesce(${portfolioId}, '')
  `;
  return rows.map(toHit);
}

async function oneDoc(sql: Sql, ownerId: string, id: string): Promise<DocHit | null> {
  const rows = await sql<{
    id: string;
    title: string;
    kind: "markdown" | "file";
    portfolio_id: string | null;
    file_name: string | null;
    file_mime: string | null;
    file_key: string | null;
    file_size: unknown;
    updated_at: unknown;
    bytes: unknown;
  }>`
    select id, title, kind, portfolio_id, file_name, file_mime, file_key, file_size, updated_at,
      octet_length(coalesce(content, '')) as bytes
    from vault_doc
    where user_id = ${ownerId} and id = ${id} and not deleted
    limit 1
  `;
  return rows[0] ? toHit(rows[0]) : null;
}

function toHit(row: {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolio_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_key: string | null;
  file_size: unknown;
  updated_at: unknown;
  bytes: unknown;
}): DocHit {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    portfolioId: row.portfolio_id,
    fileName: row.file_name,
    fileMime: row.file_mime,
    fileKey: row.file_key,
    fileSize: Number(row.file_size ?? 0),
    updatedAt: Number(row.updated_at),
    bytes: Number(row.bytes ?? 0),
  };
}

function baseOf(
  kind: "portfolio" | "markdown" | "file",
  title: string,
  fileName: string | null,
): string {
  if (kind === "portfolio") return sanitizeBase(title) || "carpeta";
  if (kind === "markdown") return noteFileName(title);
  return sanitizeBase(fileName || title) || "archivo";
}

async function noteContent(sql: Sql, ownerId: string, id: string): Promise<string | null> {
  const rows = await sql<{ content: string }>`
    select content from vault_doc where user_id = ${ownerId} and id = ${id} and not deleted limit 1
  `;
  return rows[0]?.content ?? null;
}

async function titleFree(
  sql: Sql,
  ownerId: string,
  title: string,
  exceptId = "",
): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from vault_doc
    where user_id = ${ownerId} and not deleted and kind = 'markdown' and lower(title) = lower(${title}) and id <> ${exceptId}
    limit 1
  `;
  return rows.length === 0;
}

async function docIdsIn(sql: Sql, ownerId: string, portfolioIds: Set<string>): Promise<string[]> {
  if (portfolioIds.size === 0) return [];
  const rows = await sql<{ id: string; portfolio_id: string | null }>`
    select id, portfolio_id from vault_doc where user_id = ${ownerId} and not deleted
  `;
  return rows
    .filter((row) => row.portfolio_id !== null && portfolioIds.has(row.portfolio_id))
    .map((row) => row.id);
}

async function renameStoredFile(
  sql: Sql,
  ownerId: string,
  id: string,
  name: string,
  actor: string,
  portfolioId?: string | null,
): Promise<void> {
  const clean = sanitizeBase(name) || "archivo";
  const rev = await nextRevision(sql, ownerId);
  const now = Date.now();
  if (portfolioId === undefined) {
    await sql`
      update vault_doc set file_name = ${clean}, title = ${noteTitleFromName(clean).slice(0, 200)},
        updated_at = ${now}, updated_by = ${actor}, rev = ${rev}
      where user_id = ${ownerId} and id = ${id} and not deleted
    `;
    return;
  }
  await sql`
    update vault_doc set file_name = ${clean}, title = ${noteTitleFromName(clean).slice(0, 200)}, portfolio_id = ${portfolioId},
      updated_at = ${now}, updated_by = ${actor}, rev = ${rev}
    where user_id = ${ownerId} and id = ${id} and not deleted
  `;
}

async function setFileKey(
  sql: Sql,
  ownerId: string,
  id: string,
  input: { key: string; size: number; name: string; mime: string; actor: string },
): Promise<void> {
  const rev = await nextRevision(sql, ownerId);
  const now = Date.now();
  await sql`
    update vault_doc set file_key = ${input.key}, file_size = ${input.size}, file_name = ${input.name},
      file_mime = ${input.mime}, title = ${noteTitleFromName(input.name).slice(0, 200)},
      updated_at = ${now}, updated_by = ${input.actor}, rev = ${rev}
    where user_id = ${ownerId} and id = ${id} and not deleted
  `;
}
