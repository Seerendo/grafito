import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import { signatureMaterial } from "@/domain/signature";
import { editableTarget, grantedDocOwner, sharedWith } from "@/server/share";
import { getDoc } from "@/server/vault";
import type { Document } from "@/domain/vault/types";

/**
 * Seguimiento de firmas (migración 0030). Quien puede editar un documento pide
 * a otras personas, que ya pueden abrirlo, que confirmen la versión actual.
 * Firmar guarda el resumen de esa versión. Si el documento cambia después, la
 * firma sigue en el historial marcada como anterior. No interviene ningún
 * certificado.
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

/** Si `userId` puede pedir firmas: es el dueño, o lo tiene con permiso de edición. */
export async function canRequestSignatures(sql: Sql, userId: string, ownerId: string, docId: string, shareId?: string): Promise<boolean> {
  if (userId === ownerId) return Boolean(await getDoc(sql, ownerId, docId));
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

export async function listSignatures(sql: Sql, ownerId: string, docId: string): Promise<SignatureRow[]> {
  const doc = await getDoc(sql, ownerId, docId);
  const current = doc ? fingerprintOf(doc) : "";
  const rows = await sql<{
    id: string;
    signer_id: string;
    signer_name: string;
    status: string;
    requested_by_name: string;
    requested_at: unknown;
    decided_at: unknown;
    fingerprint: string;
    note: string;
  }>`
    select id, signer_id, signer_name, status, requested_by_name, requested_at, decided_at, fingerprint, note
    from doc_signature where owner_id = ${ownerId} and doc_id = ${docId}
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
    stale: statusOf(row.status) === "signed" && row.fingerprint !== "" && row.fingerprint !== current,
  }));
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
  const rows = await sql<{ owner_id: string; doc_id: string; signer_id: string; status: string }>`
    select owner_id, doc_id, signer_id, status from doc_signature where id = ${input.id} limit 1
  `;
  const row = rows[0];
  if (!row || row.signer_id !== input.userId) return { ok: false, error: "Esa firma ya no está pendiente." };
  if (row.status !== "pending") return { ok: false, error: "Esa firma ya no está pendiente." };
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
    where s.signer_id = ${userId} and s.status = 'pending'
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
}
