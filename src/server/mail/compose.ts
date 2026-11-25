import MailComposer from "nodemailer/lib/mail-composer";
import type { Sql } from "@/lib/db";
import { safeFileName } from "@/domain/mail/message";
import { exportPermission } from "@/domain/permissions";
import type { Document } from "@/domain/vault/types";
import { readBlob } from "@/server/blobs";
import { decodeDataUrl } from "@/server/files";
import { vaultSnapshot } from "@/server/mcp/corpus";
import { allows, type UserProfile } from "@/server/profile";
import { grantedDocOwner, sharedWith } from "@/server/share";
import { getDoc, listDocs } from "@/server/vault";
import { buildConnector, connectorAccount } from "./accounts";
import { MailError } from "./providers/types";
import { enqueue } from "./queue";

/**
 * Writing mail: the documents a person may attach (their Carpeta Personal and what is shared with
 * them, only when their role may download files or export notes), and sending through one of their
 * accounts. Attachments are read from the vault on the server, never uploaded from the browser.
 */

/** Total size of the attachments of one message (providers accept about 25 MB). */
export const MAX_SEND_BYTES = 20 * 1024 * 1024;
export const MAX_SEND_ATTACHMENTS = 20;
const MAX_RECIPIENTS = 100;

export type PickerDoc = {
  id: string;
  /** null for the person's own vault. */
  shareId: string | null;
  portfolioId: string | null;
  title: string;
  kind: "markdown" | "file";
  fileName: string | null;
};

export type PickerFolder = {
  id: string;
  shareId: string | null;
  parentId: string | null;
  name: string;
};

export type PickerPlace = { shareId: string | null; label: string };

function attachable(profile: UserProfile, kind: "markdown" | "file"): boolean {
  return allows(profile, exportPermission(kind));
}

/** Folders and documents to pick from; with a query, the matching documents only. */
export async function attachmentChoices(
  sql: Sql,
  userId: string,
  profile: UserProfile,
  query: string,
): Promise<{ places: PickerPlace[]; folders: PickerFolder[]; docs: PickerDoc[] }> {
  const view = await vaultSnapshot(sql, userId);
  const shares = await sharedWith(sql, userId);
  const labels = new Map(
    shares.map((share) => [share.id, `${share.title} · ${share.ownerName}`] as const),
  );
  const places: PickerPlace[] = [{ shareId: null, label: "Carpeta Personal" }];
  for (const share of shares)
    if (
      view.docs.some((doc) => doc.shareId === share.id) ||
      view.folders.some((f) => f.shareId === share.id)
    )
      places.push({ shareId: share.id, label: labels.get(share.id) ?? share.title });
  const pick = (doc: {
    id: string;
    shareId: string | null;
    portfolioId: string | null;
    title: string;
    kind: "markdown" | "file";
    fileName: string | null;
  }): PickerDoc => ({
    id: doc.id,
    shareId: doc.shareId,
    portfolioId: doc.portfolioId,
    title: doc.title,
    kind: doc.kind,
    fileName: doc.fileName,
  });
  const term = query.trim().toLowerCase();
  let docs: PickerDoc[];
  if (term) {
    // Own documents beyond the snapshot's limit are found by the vault's own search.
    const own = await listDocs(sql, userId, { query: term, limit: 100 });
    docs = [
      ...own.map((doc) => pick({ ...doc, shareId: null, fileName: doc.fileName ?? null })),
      ...view.docs.filter((doc) => doc.shareId && doc.title.toLowerCase().includes(term)).map(pick),
    ].slice(0, 200);
  } else docs = view.docs.map(pick);
  return {
    places,
    folders: view.folders
      .filter((folder): folder is typeof folder & { id: string } => folder.id !== null)
      .map((folder) => ({
        id: folder.id,
        shareId: folder.shareId,
        parentId: folder.parentId,
        name: folder.name,
      })),
    docs: docs.filter((doc) => attachable(profile, doc.kind)),
  };
}

type Attachment = { filename: string; contentType: string; content: Buffer; docId: string };

/** A vault document as an attachment, if this person may open it and take it out of Grafito. */
async function vaultAttachment(
  sql: Sql,
  userId: string,
  profile: UserProfile,
  ref: { docId: string; shareId: string | null },
): Promise<Attachment> {
  const owner = ref.shareId ? await grantedDocOwner(sql, userId, ref.shareId, ref.docId) : userId;
  const doc: Document | null = owner ? await getDoc(sql, owner, ref.docId) : null;
  if (!doc) throw new MailError("permanent", "Uno de los documentos ya no está disponible.");
  if (!attachable(profile, doc.kind))
    throw new MailError(
      "permanent",
      doc.kind === "file"
        ? "Tu rol no permite descargar archivos, así que no puedes adjuntarlos."
        : "Tu rol no permite exportar notas, así que no puedes adjuntarlas.",
    );
  if (doc.kind === "markdown") {
    const name = safeFileName(`${doc.title || "Nota"}.md`);
    return {
      filename: name,
      contentType: "text/markdown; charset=utf-8",
      content: Buffer.from(doc.content, "utf8"),
      docId: doc.id,
    };
  }
  const file = doc.file;
  if (!file) throw new MailError("permanent", `«${doc.title}» no tiene archivo.`);
  if ((file.size ?? 0) > MAX_SEND_BYTES)
    throw new MailError(
      "permanent",
      `«${doc.title}» es demasiado grande para enviarlo por correo.`,
    );
  let bytes: Uint8Array | null = null;
  if (file.key) bytes = await readBlob(sql, file.key);
  else if (file.dataUrl) bytes = decodeDataUrl(file.dataUrl)?.bytes ?? null;
  if (!bytes) throw new MailError("temporary", `No se pudo leer «${doc.title}».`);
  return {
    filename: safeFileName(file.name || doc.title),
    contentType: file.mime || "application/octet-stream",
    content: Buffer.from(bytes),
    docId: doc.id,
  };
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Plain addresses or «Name <address>»; only the address is kept. */
function addresses(list: string[]): string[] {
  const clean = list
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => /<([^<>]+)>\s*$/.exec(item)?.[1]?.trim() ?? item);
  for (const item of clean)
    if (!EMAIL.test(item))
      throw new MailError("permanent", `«${item}» no es una dirección válida.`);
  return [...new Set(clean.map((item) => item.toLowerCase()))];
}

export type SendInput = {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: { docId: string; shareId: string | null }[];
  /** The message this answers (its id in Grafito), for In-Reply-To and References. */
  replyTo: string | null;
};

/** Compose and send one message as one of the person's accounts. */
export async function sendMessage(
  sql: Sql,
  userId: string,
  profile: UserProfile,
  input: SendInput,
): Promise<{ sentCopy: boolean; attachments: string[]; recipients: number }> {
  const owned = await sql<{ id: string }>`
    select id from mail_account where id = ${input.accountId} and user_id = ${userId} limit 1
  `;
  const account = owned[0] ? await connectorAccount(sql, input.accountId) : null;
  if (!account) throw new MailError("permanent", "Esa cuenta no existe.");
  if (!account.secret) throw new MailError("permanent", "La cuenta está desconectada.");
  const to = addresses(input.to);
  const cc = addresses(input.cc);
  const bcc = addresses(input.bcc);
  const recipients = [...new Set([...to, ...cc, ...bcc])];
  if (recipients.length === 0)
    throw new MailError("permanent", "Escribe al menos un destinatario.");
  if (recipients.length > MAX_RECIPIENTS)
    throw new MailError("permanent", `Como mucho ${MAX_RECIPIENTS} destinatarios.`);
  if (input.attachments.length > MAX_SEND_ATTACHMENTS)
    throw new MailError("permanent", `Como mucho ${MAX_SEND_ATTACHMENTS} adjuntos.`);

  const files: Attachment[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const ref of input.attachments) {
    const key = `${ref.shareId ?? ""}:${ref.docId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = await vaultAttachment(sql, userId, profile, ref);
    total += file.content.byteLength;
    if (total > MAX_SEND_BYTES)
      throw new MailError("permanent", "Los adjuntos superan los 20 MB que admite un correo.");
    files.push(file);
  }

  let thread: { inReplyTo?: string; references?: string } = {};
  if (input.replyTo) {
    const rows = await sql<{ internet_message_id: string }>`
      select internet_message_id from mail_message where id = ${input.replyTo} and user_id = ${userId} limit 1
    `;
    const id = rows[0]?.internet_message_id?.trim();
    if (id) thread = { inReplyTo: id, references: id };
  }

  const composer = new MailComposer({
    from: { name: profile.displayName || "", address: account.email },
    to,
    cc,
    bcc,
    subject: input.subject.slice(0, 500),
    text: input.text,
    ...thread,
    attachments: files.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      content: file.content,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const node = composer.compile();
  // SMTP takes the recipients from the envelope, so Bcc stays out of the copy; the APIs read them
  // from the headers and remove Bcc themselves.
  node.keepBcc = account.provider !== "imap";
  const raw = await node.build();

  const connector = await buildConnector(sql, account);
  let result: { sentCopy: boolean };
  try {
    result = await connector.send({ raw, from: account.email, recipients });
  } finally {
    await connector.close();
  }
  // The copy in Sent arrives with the next sync.
  await enqueue(sql, { userId, accountId: account.id, kind: "sync", priority: 5 });
  return {
    sentCopy: result.sentCopy,
    attachments: files.map((file) => file.docId),
    recipients: recipients.length,
  };
}
