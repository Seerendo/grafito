import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import {
  messageMarkdown,
  messagePlainText,
  safeFileName,
  type ArchiveInput,
} from "@/domain/mail/message";
import { deleteBlob, putBlob, readBlob } from "@/server/blobs";
import { blockUnsafeBlob } from "@/server/clamav";
import { newFileKey } from "@/server/files";
import { checkSpace } from "@/server/space";
import { uploadTarget } from "@/server/upload-target";
import { attachManualLink, createPortfolio, registerImportedDoc, VaultError } from "@/server/vault";
import { getMessage } from "./messages";
import { enqueue } from "./queue";

/**
 * Bringing mail into the vault. An archived message or attachment becomes an ordinary document
 * (the same checks as an upload: destination rights, quota, antivirus, then indexing and the
 * graph as usual) and stays when the message is deleted on the server or the account is
 * disconnected. mail_archive_reference only remembers where it came from.
 */

export type ArchiveTarget = {
  shareId?: string | null;
  portfolioId?: string | null;
  newPortfolio?: string;
};

type Resolved = { ownerId: string; portfolioId: string | null };

async function resolveTarget(sql: Sql, userId: string, target: ArchiveTarget): Promise<Resolved> {
  let portfolioId = target.portfolioId ?? null;
  if (target.newPortfolio?.trim()) {
    if (target.shareId)
      throw new VaultError("Las carpetas nuevas se crean en tu Carpeta Personal.");
    portfolioId = (
      await createPortfolio(sql, userId, { name: target.newPortfolio, parentId: portfolioId })
    ).id;
  }
  const resolved = await uploadTarget(sql, userId, {
    shareId: target.shareId ?? null,
    portfolioId,
  });
  if (typeof resolved === "string") throw new VaultError(resolved, 403);
  return { ownerId: resolved.ownerId, portfolioId: resolved.portfolioId };
}

async function reference(
  sql: Sql,
  input: {
    userId: string;
    accountId: string;
    messageId: string;
    attachmentId: string | null;
    ownerId: string;
    documentId: string;
    portfolioId: string | null;
    format: string;
    internetMessageId: string;
    actor: string;
  },
): Promise<void> {
  await sql`
    insert into mail_archive_reference (id, user_id, account_id, message_id, attachment_id, document_owner_id,
      document_id, portfolio_id, format, internet_message_id, archived_by, archived_at)
    values (${randomUUID()}, ${input.userId}, ${input.accountId}, ${input.messageId}, ${input.attachmentId},
      ${input.ownerId}, ${input.documentId}, ${input.portfolioId}, ${input.format}, ${input.internetMessageId},
      ${input.actor}, ${Date.now()})
  `;
}

/** Copy a downloaded, scanned attachment into the vault as a file. */
async function saveAttachment(
  sql: Sql,
  userId: string,
  actor: string,
  target: Resolved,
  message: { id: string; accountId: string; internetMessageId: string },
  attachmentId: string,
): Promise<{ id: string; title: string }> {
  const rows = await sql<{
    id: string;
    filename: string;
    content_type: string;
    storage_key: string | null;
    download_status: string;
    antivirus_status: string;
  }>`
    select id, filename, content_type, storage_key, download_status, antivirus_status from mail_attachment
    where id = ${attachmentId} and message_id = ${message.id} and user_id = ${userId} limit 1
  `;
  const row = rows[0];
  if (!row) throw new VaultError("Ese adjunto no existe.", 404);
  if (row.download_status !== "ready" || !row.storage_key)
    throw new VaultError("Primero hay que descargar el adjunto.", 409);
  if (row.antivirus_status !== "clean" && row.antivirus_status !== "off")
    throw new VaultError("Ese adjunto no pasó el antivirus.", 422);
  const bytes = await readBlob(sql, row.storage_key);
  if (!bytes) throw new VaultError("El adjunto ya no está guardado. Descárgalo otra vez.", 409);
  const full = await checkSpace(sql, { ...target, uploaderId: userId, bytes: bytes.byteLength });
  if (full) throw new VaultError(full, 413);
  const key = newFileKey(target.ownerId);
  await putBlob(sql, key, bytes, row.content_type || "application/octet-stream");
  const blocked = await blockUnsafeBlob(sql, key);
  if (blocked) throw new VaultError(blocked.message, blocked.status);
  const name = safeFileName(row.filename, "adjunto");
  const now = Date.now();
  const docId = randomUUID();
  try {
    await registerImportedDoc(sql, target.ownerId, {
      id: docId,
      title: name.replace(/\.[^.]{1,12}$/, "") || name,
      kind: "file",
      portfolioId: target.portfolioId,
      content: "",
      file: {
        name,
        mime: row.content_type || "application/octet-stream",
        key,
        size: bytes.byteLength,
      },
      links: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    });
  } catch (error) {
    await deleteBlob(sql, key).catch(() => undefined);
    throw error;
  }
  await reference(sql, {
    userId,
    accountId: message.accountId,
    messageId: message.id,
    attachmentId: row.id,
    ownerId: target.ownerId,
    documentId: docId,
    portfolioId: target.portfolioId,
    format: "file",
    internetMessageId: message.internetMessageId,
    actor,
  });
  return { id: docId, title: name };
}

export async function archiveAttachments(
  sql: Sql,
  userId: string,
  actor: string,
  messageId: string,
  attachmentIds: string[],
  target: ArchiveTarget,
): Promise<{ id: string; title: string }[]> {
  const message = await getMessage(sql, userId, messageId);
  if (!message) throw new VaultError("Ese mensaje no existe.", 404);
  const resolved = await resolveTarget(sql, userId, target);
  const saved = [];
  for (const id of attachmentIds.slice(0, 50))
    saved.push(await saveAttachment(sql, userId, actor, resolved, message, id));
  return saved;
}

/**
 * Archive a message as a Markdown note or a plain text file, with its provenance. With
 * `withAttachments`, its downloaded attachments are saved next to it and linked from the note, so
 * the graph shows them together.
 */
export async function archiveMessage(
  sql: Sql,
  userId: string,
  actor: string,
  messageId: string,
  input: { format: "markdown" | "text"; target: ArchiveTarget; withAttachments: boolean },
): Promise<{ id: string; title: string; attachments: number }> {
  const message = await getMessage(sql, userId, messageId);
  if (!message) throw new VaultError("Ese mensaje no existe.", 404);
  const resolved = await resolveTarget(sql, userId, input.target);
  const content: ArchiveInput = {
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc,
    date: message.sentAt ?? message.receivedAt,
    account: message.account.email,
    messageId: message.internetMessageId,
    text: message.text || message.snippet,
    attachments: message.attachments
      .filter((item) => !item.inline)
      .map((item) => ({ name: safeFileName(item.filename), size: item.size })),
    archivedAt: Date.now(),
  };
  const title = safeFileName(message.subject.trim() || "Correo sin asunto", "Correo").slice(0, 150);
  const now = Date.now();
  const docId = randomUUID();
  if (input.format === "markdown") {
    await registerImportedDoc(sql, resolved.ownerId, {
      id: docId,
      title,
      kind: "markdown",
      portfolioId: resolved.portfolioId,
      content: messageMarkdown(content),
      file: null,
      links: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    });
  } else {
    const bytes = new TextEncoder().encode(messagePlainText(content));
    const full = await checkSpace(sql, {
      ...resolved,
      uploaderId: userId,
      bytes: bytes.byteLength,
    });
    if (full) throw new VaultError(full, 413);
    const key = newFileKey(resolved.ownerId);
    await putBlob(sql, key, bytes, "text/plain; charset=utf-8");
    await registerImportedDoc(sql, resolved.ownerId, {
      id: docId,
      title,
      kind: "file",
      portfolioId: resolved.portfolioId,
      content: "",
      file: { name: `${title}.txt`, mime: "text/plain", key, size: bytes.byteLength },
      links: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
    });
  }
  await reference(sql, {
    userId,
    accountId: message.accountId,
    messageId,
    attachmentId: null,
    ownerId: resolved.ownerId,
    documentId: docId,
    portfolioId: resolved.portfolioId,
    format: input.format,
    internetMessageId: message.internetMessageId,
    actor,
  });
  let attachments = 0;
  if (input.withAttachments) {
    for (const item of message.attachments) {
      if (item.inline || item.status !== "ready") continue;
      const saved = await saveAttachment(sql, userId, actor, resolved, message, item.id);
      attachments += 1;
      if (resolved.ownerId === userId && input.format === "markdown")
        await attachManualLink(
          sql,
          userId,
          docId,
          { targetId: saved.id, kind: "referencia" },
          actor,
        );
    }
  }
  return { id: docId, title, attachments };
}

/**
 * The message exactly as the server holds it (.eml), fetched by the worker: the request is
 * queued and the document appears when it is stored.
 */
export async function archiveEml(
  sql: Sql,
  userId: string,
  actor: string,
  messageId: string,
  target: ArchiveTarget,
): Promise<{ queued: true; documentId: string }> {
  const message = await getMessage(sql, userId, messageId);
  if (!message) throw new VaultError("Ese mensaje no existe.", 404);
  const resolved = await resolveTarget(sql, userId, target);
  const documentId = randomUUID();
  await enqueue(sql, {
    userId,
    accountId: message.accountId,
    kind: "eml",
    payload: {
      messageId,
      ownerId: resolved.ownerId,
      portfolioId: resolved.portfolioId,
      documentId,
      actor,
      shareId: target.shareId ?? null,
    },
    dedupe: `eml:${messageId}:${documentId}`,
    priority: 15,
  });
  return { queued: true, documentId };
}
