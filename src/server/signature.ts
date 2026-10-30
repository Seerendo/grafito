import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { signatureMaterial } from "@/domain/signature";
import { isPdfFile, validBox, type SignatureBox } from "@/domain/signature-box";
import { keepSigners } from "@/domain/signature-people";
import { readBlob, putBlob } from "@/server/blobs";
import { newFileKey } from "@/server/files";
import { editableTarget, grantedDocOwner, portfolioMembers, sharedWith } from "@/server/share";
import { orgMemberIds, workspaceByOwner } from "@/server/workspace";
import { decodeCertificate, hasCertificateSignature, stampCertificate } from "@/server/signature-p12";
import { decodeSignatureImage, pdfPageCount, stampSignature } from "@/server/signature-stamp";
import { getDoc, replaceFile, VaultError } from "@/server/vault";
import type { Document } from "@/domain/vault/types";

/**
 * Firmas en un PDF (migraciones 0030 y 0033). Quien puede editarlo marca un
 * recuadro por persona. Esa persona firma una vez, con una imagen o con un
 * certificado .p12. Ni la imagen, ni el certificado, ni la contraseña se
 * guardan. Si el PDF cambia después por otro motivo, la lista lo dice.
 */

export type SignatureStatus = "pending" | "signed" | "declined";

export type SignatureRow = {
  id: string;
  signerId: string;
  signerName: string;
  status: SignatureStatus;
  requestedByName: string;
  requestedAt: number;
  decidedAt: number | null;
  note: string;
  stale: boolean;
  page: number | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
};

const MAX_NOTE = 500;

function fingerprintOf(doc: Document): string {
  const fileKey = doc.file?.key || (doc.file ? `${doc.file.name}:${doc.file.size ?? 0}` : "");
  return createHash("sha256")
    .update(signatureMaterial({ kind: doc.kind, title: doc.title, content: doc.content, fileKey }))
    .digest("hex");
}

function statusOf(value: string): SignatureStatus {
  return value === "signed" || value === "declined" ? value : "pending";
}

/** Dueño del documento si `userId` es el dueño o lo tiene compartido. */
export async function signatureOwner(sql: Sql, userId: string, docId: string, shareId?: string): Promise<string | null> {
  if (!shareId) return (await getDoc(sql, userId, docId)) ? userId : null;
  return grantedDocOwner(sql, userId, shareId, docId);
}

/** Si `userId` puede colocar recuadros: es un PDF, y es el dueño o lo tiene con permiso de edición. */
export async function canRequestSignatures(sql: Sql, userId: string, ownerId: string, docId: string, shareId?: string): Promise<boolean> {
  const doc = await getDoc(sql, ownerId, docId);
  if (!doc?.file || !isPdfFile(doc.file.name, doc.file.mime)) return false;
  if (userId === ownerId) return true;
  if (!shareId) return false;
  const target = await editableTarget(sql, userId, shareId, docId);
  return target?.ownerId === ownerId;
}

async function readableBy(sql: Sql, userId: string, ownerId: string, docId: string): Promise<boolean> {
  if (userId === ownerId) return Boolean(await getDoc(sql, ownerId, docId));
  const shares = await sql<{ id: string }>`
    with recursive mine(id) as (
      select org_id from app_org_member where user_id = ${userId}
      union
      select o.parent_id from app_org o join mine m on o.id = m.id where o.parent_id is not null
    )
    select s.id from share_item s
    where s.owner_id = ${ownerId} and s.visibility = 'shared'
      and (
        exists (
          select 1 from share_grant g
          where g.share_id = s.id and g.user_id = ${userId} and (g.expires_at is null or g.expires_at > ${Date.now()})
        )
        or exists (
          select 1 from share_org_grant g
          where g.share_id = s.id and g.org_id in (select id from mine) and (g.expires_at is null or g.expires_at > ${Date.now()})
        )
      )
  `;
  for (const share of shares) {
    if (await grantedDocOwner(sql, userId, share.id, docId)) return true;
  }
  return false;
}

export type SignaturePerson = { id: string; name: string; loginName: string; self: boolean };

/**
 * A quién se le puede marcar un recuadro en este PDF. No es la lista de
 * usuarios del sistema: en una carpeta personal, con quien se compartió el
 * documento (él o una carpeta que lo contiene) y su dueño; en un espacio de
 * trabajo, los de la organización con acceso a esa carpeta y quienes lo
 * administran. Quien lo pide también, si puede abrirlo, para firmarlo él.
 */
export async function signatureAudience(
  sql: Sql,
  ownerId: string,
  docId: string,
  callerId: string,
): Promise<SignaturePerson[]> {
  const doc = await getDoc(sql, ownerId, docId);
  if (!doc) return [];
  const hidden = new Set((await sql<{ owner_id: string }>`select owner_id from workspace`).map((row) => row.owner_id));
  const granted = new Map<string, { id: string; name: string; loginName: string }>();
  const add = (id: string, name: string, loginName: string) => {
    if (!id || hidden.has(id) || granted.has(id)) return;
    granted.set(id, { id, name: name.trim() || loginName || "Sin nombre", loginName: loginName ?? "" });
  };
  const workspace = await workspaceByOwner(sql, ownerId);
  if (workspace) {
    const org = await orgMemberIds(sql, workspace.org_id);
    const now = Date.now();
    const admins = await sql<{ id: string; name: string; login_name: string | null }>`
      select u.id, u.name, coalesce(r.login_name, a.login_name) as login_name
      from workspace w
      join share_grant g on g.share_id = w.share_id
      join "user" u on u.id = g.user_id
      left join app_user_role r on r.user_id = u.id
      left join app_admin a on a.user_id = u.id
      where w.owner_id = ${ownerId} and g.access in ('admin', 'edit')
        and (g.expires_at is null or g.expires_at > ${now})
    `;
    for (const row of admins) if (org.has(row.id)) add(row.id, row.name ?? "", row.login_name ?? "");
    if (doc.portfolioId) {
      const folder = await sql<{ id: string; name: string; login_name: string | null }>`
        select u.id, u.name, coalesce(r.login_name, a.login_name) as login_name
        from workspace_access x
        join "user" u on u.id = x.user_id
        left join app_user_role r on r.user_id = u.id
        left join app_admin a on a.user_id = u.id
        where x.owner_id = ${ownerId} and x.portfolio_id = ${doc.portfolioId}
      `;
      for (const row of folder) if (org.has(row.id)) add(row.id, row.name ?? "", row.login_name ?? "");
    }
  } else {
    if (doc.portfolioId) {
      for (const member of await portfolioMembers(sql, ownerId, doc.portfolioId)) add(member.userId, member.name, member.loginName);
    }
    await addDocumentShare(sql, ownerId, docId, add);
  }
  const ids = keepSigners({ ownerId, callerId, grantedIds: [...granted.keys()], hiddenIds: hidden });
  const people: SignaturePerson[] = [];
  for (const id of ids) {
    const known = granted.get(id) ?? (await personById(sql, id));
    if (known) people.push({ ...known, self: id === callerId });
  }
  people.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name, "es"));
  return people;
}

/** Invitados del propio documento (no de una carpeta que lo contiene). */
async function addDocumentShare(
  sql: Sql,
  ownerId: string,
  docId: string,
  add: (id: string, name: string, loginName: string) => void,
): Promise<void> {
  const now = Date.now();
  const direct = await sql<{ id: string; name: string; login_name: string | null }>`
    select u.id, u.name, coalesce(r.login_name, a.login_name) as login_name
    from share_item s
    join share_grant g on g.share_id = s.id
    join "user" u on u.id = g.user_id
    left join app_user_role r on r.user_id = u.id
    left join app_admin a on a.user_id = u.id
    where s.owner_id = ${ownerId} and s.kind = 'document' and s.target_id = ${docId} and s.visibility = 'shared'
      and (g.expires_at is null or g.expires_at > ${now})
  `;
  for (const row of direct) add(row.id, row.name ?? "", row.login_name ?? "");
  const viaOrg = await sql<{ id: string; name: string; login_name: string | null }>`
    with recursive tree(id) as (
      select o.id from app_org o
      join share_org_grant g on g.org_id = o.id
      join share_item s on s.id = g.share_id
      where s.owner_id = ${ownerId} and s.kind = 'document' and s.target_id = ${docId} and s.visibility = 'shared'
        and (g.expires_at is null or g.expires_at > ${now})
      union
      select c.id from app_org c join tree t on c.parent_id = t.id
    )
    select distinct u.id, u.name, coalesce(r.login_name, a.login_name) as login_name
    from tree t
    join app_org_member m on m.org_id = t.id
    join "user" u on u.id = m.user_id
    left join app_user_role r on r.user_id = u.id
    left join app_admin a on a.user_id = u.id
  `;
  for (const row of viaOrg) add(row.id, row.name ?? "", row.login_name ?? "");
}

async function personById(sql: Sql, id: string): Promise<{ id: string; name: string; loginName: string } | null> {
  const rows = await sql<{ name: string; login_name: string | null }>`
    select u.name, coalesce(r.login_name, a.login_name) as login_name
    from "user" u
    left join app_user_role r on r.user_id = u.id
    left join app_admin a on a.user_id = u.id
    where u.id = ${id}
    limit 1
  `;
  const row = rows[0];
  if (!row || (!row.name?.trim() && !row.login_name)) return null;
  return { id, name: row.name?.trim() || row.login_name || "Sin nombre", loginName: row.login_name ?? "" };
}

function boxOf(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function listSignatures(sql: Sql, ownerId: string, docId: string): Promise<SignatureRow[]> {
  const doc = await getDoc(sql, ownerId, docId);
  const currentKey = doc?.file?.key ?? "";
  const heads = await sql<{ file_key: string }>`
    select file_key from doc_signature_file where owner_id = ${ownerId} and doc_id = ${docId} limit 1
  `;
  const head = heads[0]?.file_key ?? "";
  const rows = await sql<{
    id: string;
    signer_id: string;
    signer_name: string;
    status: string;
    requested_by_name: string;
    requested_at: unknown;
    decided_at: unknown;
    note: string;
    page: unknown;
    box_x: unknown;
    box_y: unknown;
    box_w: unknown;
    box_h: unknown;
  }>`
    select id, signer_id, signer_name, status, requested_by_name, requested_at, decided_at, note,
      page, box_x, box_y, box_w, box_h
    from doc_signature
    where owner_id = ${ownerId} and doc_id = ${docId} and page is not null
    order by requested_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    signerId: row.signer_id,
    signerName: row.signer_name,
    status: statusOf(row.status),
    requestedByName: row.requested_by_name,
    requestedAt: Number(row.requested_at),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    note: row.note,
    page: boxOf(row.page),
    x: boxOf(row.box_x),
    y: boxOf(row.box_y),
    w: boxOf(row.box_w),
    h: boxOf(row.box_h),
    stale: statusOf(row.status) === "signed" && head !== "" && head !== currentKey,
  }));
}

/** El dueño o quien edita marca el recuadro de una persona que ya puede leer el PDF. */
export async function placeSignatureBox(
  sql: Sql,
  input: { ownerId: string; docId: string; requesterId: string; requesterName: string; signerId: string; box: SignatureBox },
): Promise<{ ok: true } | { ok: false; error: string; who?: string }> {
  const doc = await getDoc(sql, input.ownerId, input.docId);
  if (!doc?.file?.key || !isPdfFile(doc.file.name, doc.file.mime)) return { ok: false, error: "Solo se puede firmar un PDF." };
  const bytes = await readBlob(sql, doc.file.key);
  if (!bytes) return { ok: false, error: "Ese archivo no existe." };
  let pages = 0;
  try {
    pages = await pdfPageCount(bytes);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo estampar la firma en el PDF." };
  }
  if (!validBox(input.box, pages)) return { ok: false, error: "El recuadro no cabe en la página." };
  const people = await sql<{ name: string }>`select name from "user" where id = ${input.signerId}`;
  const name = people[0]?.name?.trim();
  if (!name) return { ok: false, error: "Esa persona ya no existe." };
  const audience = await signatureAudience(sql, input.ownerId, input.docId, input.requesterId);
  if (!audience.some((person) => person.id === input.signerId)) {
    return { ok: false, error: "Comparte el documento con {0} antes de pedirle la firma.", who: name };
  }
  const existing = await sql<{ id: string; status: string }>`
    select id, status from doc_signature
    where owner_id = ${input.ownerId} and doc_id = ${input.docId} and signer_id = ${input.signerId} and page is not null
    order by requested_at desc
  `;
  if (existing.some((row) => row.status === "signed")) return { ok: false, error: "Esa persona ya firmó este PDF." };
  const pending = existing.find((row) => row.status === "pending");
  const now = Date.now();
  if (pending) {
    await sql`
      update doc_signature set page = ${input.box.page}, box_x = ${input.box.x}, box_y = ${input.box.y},
        box_w = ${input.box.w}, box_h = ${input.box.h}, signer_name = ${name},
        requested_by = ${input.requesterId}, requested_by_name = ${input.requesterName}, requested_at = ${now}
      where id = ${pending.id}
    `;
    return { ok: true };
  }
  await sql`
    insert into doc_signature (
      id, owner_id, doc_id, signer_id, signer_name, status, requested_by, requested_by_name, requested_at,
      fingerprint, note, page, box_x, box_y, box_w, box_h
    ) values (
      ${randomUUID()}, ${input.ownerId}, ${input.docId}, ${input.signerId}, ${name}, 'pending',
      ${input.requesterId}, ${input.requesterName}, ${now}, '', '',
      ${input.box.page}, ${input.box.x}, ${input.box.y}, ${input.box.w}, ${input.box.h}
    )
  `;
  return { ok: true };
}

/** Quita un recuadro que todavía nadie ha firmado. */
export async function removeSignatureBox(sql: Sql, input: { ownerId: string; id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql<{ status: string; page: unknown }>`
    select status, page from doc_signature where id = ${input.id} and owner_id = ${input.ownerId} limit 1
  `;
  const row = rows[0];
  if (!row || row.page == null || row.status !== "pending") return { ok: false, error: "Esa firma ya no está pendiente." };
  await sql`delete from doc_signature where id = ${input.id} and status = 'pending'`;
  return { ok: true };
}

/**
 * La persona del recuadro firma una vez: con una imagen, o con su certificado
 * .p12. La imagen, el certificado y la contraseña no se guardan.
 */
export async function signPdfBox(
  sql: Sql,
  input: { userId: string; userName: string; id: string; image?: string; p12?: string; password?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql<{
    owner_id: string;
    doc_id: string;
    signer_id: string;
    status: string;
    page: unknown;
    box_x: unknown;
    box_y: unknown;
    box_w: unknown;
    box_h: unknown;
  }>`
    select owner_id, doc_id, signer_id, status, page, box_x, box_y, box_w, box_h
    from doc_signature where id = ${input.id} limit 1
  `;
  const row = rows[0];
  if (!row || row.signer_id !== input.userId || row.status !== "pending" || row.page == null) {
    return { ok: false, error: "Esa firma ya no está pendiente." };
  }
  if (!(await readableBy(sql, input.userId, row.owner_id, row.doc_id))) {
    return { ok: false, error: "Ya no tienes acceso a este documento." };
  }
  const box: SignatureBox = {
    page: Number(row.page),
    x: Number(row.box_x),
    y: Number(row.box_y),
    w: Number(row.box_w),
    h: Number(row.box_h),
  };
  const doc = await getDoc(sql, row.owner_id, row.doc_id);
  if (!doc?.file?.key || !isPdfFile(doc.file.name, doc.file.mime)) return { ok: false, error: "Solo se puede firmar un PDF." };
  const pdfBytes = await readBlob(sql, doc.file.key);
  if (!pdfBytes) return { ok: false, error: "Ese archivo no existe." };
  let stamped: Uint8Array;
  try {
    if (input.p12 != null) {
      const certificate = decodeCertificate(input.p12);
      if (certificate === "big") return { ok: false, error: "La firma es demasiado grande." };
      if (!certificate) return { ok: false, error: "Ese archivo no es un certificado .p12." };
      stamped = await stampCertificate(pdfBytes, certificate, input.password ?? "", box);
    } else if (hasCertificateSignature(pdfBytes)) {
      return { ok: false, error: "Este PDF ya tiene una firma con certificado. Una imagen la invalidaría." };
    } else {
      const image = decodeSignatureImage(input.image ?? "");
      if (image === "big") return { ok: false, error: "La firma es demasiado grande." };
      if (!image) return { ok: false, error: "La firma tiene que ser una imagen PNG o JPEG, o un certificado .p12." };
      stamped = await stampSignature(pdfBytes, image, box);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "No se pudo estampar la firma en el PDF." };
  }
  const key = newFileKey(row.owner_id);
  await putBlob(sql, key, stamped, "application/pdf");
  try {
    await replaceFile(sql, row.owner_id, row.doc_id, {
      key,
      size: stamped.byteLength,
      actor: input.userName || "Alguien",
      actorId: input.userId,
      separateVersion: true,
    });
  } catch (error) {
    if (error instanceof VaultError) return { ok: false, error: error.message };
    throw error;
  }
  const fingerprint = createHash("sha256")
    .update(signatureMaterial({ kind: "file", title: doc.title, content: "", fileKey: key }))
    .digest("hex");
  const now = Date.now();
  await sql`
    update doc_signature set status = 'signed', decided_at = ${now}, fingerprint = ${fingerprint}, note = ''
    where id = ${input.id} and status = 'pending'
  `;
  await sql`
    insert into doc_signature_file (owner_id, doc_id, file_key) values (${row.owner_id}, ${row.doc_id}, ${key})
    on conflict (owner_id, doc_id) do update set file_key = ${key}
  `;
  return { ok: true };
}

/** Pide la firma a esas personas. Quien no puede abrir el documento se devuelve en `blocked`. */
export async function requestSignatures(
  sql: Sql,
  input: { ownerId: string; docId: string; requesterId: string; requesterName: string; userIds: string[] },
): Promise<{ blocked: string[] }> {
  const blocked: string[] = [];
  const now = Date.now();
  for (const signerId of [...new Set(input.userIds)]) {
    if (signerId === input.requesterId) continue;
    const people = await sql<{ name: string }>`select name from "user" where id = ${signerId}`;
    const name = people[0]?.name?.trim();
    if (!name) continue;
    if (!(await readableBy(sql, signerId, input.ownerId, input.docId))) {
      blocked.push(name);
      continue;
    }
    const pending = await sql<{ id: string }>`
      select id from doc_signature
      where owner_id = ${input.ownerId} and doc_id = ${input.docId} and signer_id = ${signerId} and status = 'pending'
      limit 1
    `;
    if (pending[0]) {
      await sql`
        update doc_signature set requested_by = ${input.requesterId}, requested_by_name = ${input.requesterName},
          requested_at = ${now}, signer_name = ${name}
        where id = ${pending[0].id}
      `;
      continue;
    }
    await sql`
      insert into doc_signature (
        id, owner_id, doc_id, signer_id, signer_name, status, requested_by, requested_by_name, requested_at, fingerprint, note
      ) values (
        ${randomUUID()}, ${input.ownerId}, ${input.docId}, ${signerId}, ${name}, 'pending',
        ${input.requesterId}, ${input.requesterName}, ${now}, '', ''
      )
    `;
  }
  return { blocked };
}

export async function decideSignature(
  sql: Sql,
  input: { userId: string; id: string; status: "signed" | "declined"; note: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql<{ owner_id: string; doc_id: string; signer_id: string; status: string; page: unknown }>`
    select owner_id, doc_id, signer_id, status, page from doc_signature where id = ${input.id} limit 1
  `;
  const row = rows[0];
  if (!row || row.signer_id !== input.userId) return { ok: false, error: "Esa firma ya no está pendiente." };
  if (row.status !== "pending") return { ok: false, error: "Esa firma ya no está pendiente." };
  if (input.status === "signed" && row.page != null) return { ok: false, error: "Sube la imagen de tu firma." };
  if (!(await readableBy(sql, input.userId, row.owner_id, row.doc_id))) {
    return { ok: false, error: "Ya no tienes acceso a este documento." };
  }
  const doc = await getDoc(sql, row.owner_id, row.doc_id);
  if (!doc) return { ok: false, error: "Esta nota ya no existe." };
  await sql`
    update doc_signature set status = ${input.status}, decided_at = ${Date.now()},
      fingerprint = ${fingerprintOf(doc)}, note = ${input.note.slice(0, MAX_NOTE)}
    where id = ${input.id} and status = 'pending'
  `;
  return { ok: true };
}

export type PendingSignature = {
  id: string;
  ownerId: string;
  docId: string;
  title: string;
  requester: string;
  shareId: string | null;
};

/** Firmas que le pidieron a `userId` y siguen pendientes, con cómo abrir el documento. */
export async function pendingSignatures(sql: Sql, userId: string): Promise<PendingSignature[]> {
  const rows = await sql<{ id: string; owner_id: string; doc_id: string; title: string; requested_by_name: string }>`
    select s.id, s.owner_id, s.doc_id, d.title, s.requested_by_name
    from doc_signature s
    join vault_doc d on d.user_id = s.owner_id and d.id = s.doc_id and not d.deleted
    where s.signer_id = ${userId} and s.status = 'pending' and s.page is not null
      and d.kind = 'file'
      and (lower(coalesce(d.file_mime, '')) = 'application/pdf' or lower(coalesce(d.file_name, '')) like '%.pdf')
    order by s.requested_at desc
  `;
  const shares = rows.some((row) => row.owner_id !== userId) ? await sharedWith(sql, userId) : [];
  const out: PendingSignature[] = [];
  for (const row of rows) {
    let shareId: string | null = null;
    if (row.owner_id !== userId) {
      for (const share of shares) {
        if ((await grantedDocOwner(sql, userId, share.id, row.doc_id)) === row.owner_id) {
          shareId = share.id;
          break;
        }
      }
      if (!shareId) continue;
    }
    out.push({
      id: row.id,
      ownerId: row.owner_id,
      docId: row.doc_id,
      title: row.title,
      requester: row.requested_by_name,
      shareId,
    });
  }
  return out;
}

export async function purgeSignatures(sql: Sql, ownerId: string, docId: string): Promise<void> {
  await sql`delete from doc_signature where owner_id = ${ownerId} and doc_id = ${docId}`;
  await sql`delete from doc_signature_file where owner_id = ${ownerId} and doc_id = ${docId}`;
}
