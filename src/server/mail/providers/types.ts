import type { MailAddress, SpecialUse } from "@/domain/mail/message";
import type { MailPolicy } from "@/domain/mail/policy";

/**
 * The contract every mail connector meets. Each provider keeps its own way of syncing (IMAP UIDs
 * and MODSEQ, Gmail's history, Graph's delta links); what they share is how messages are handed
 * to the store and how failures are classified.
 */

export type MailErrorKind =
  /** Wrong password or revoked consent: retrying will not help until the person acts. */
  | "auth"
  /** The access token expired and could not be renewed. */
  | "expired"
  /** Network, DNS, TLS or a server that does not answer: retried with backoff. */
  | "connection"
  /** The provider asked to slow down. */
  | "rate_limited"
  /** A stored cursor (history id, delta link, UIDVALIDITY) is no longer valid. */
  | "cursor"
  /** Refused by policy or misconfigured: not retried. */
  | "permanent"
  | "temporary";

export class MailError extends Error {
  readonly kind: MailErrorKind;
  readonly retryAfterMs: number | null;
  constructor(kind: MailErrorKind, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export type RemoteFolder = {
  remoteId: string;
  name: string;
  path: string;
  parentRemoteId: string | null;
  specialUse: SpecialUse;
};

export type RemoteAttachment = {
  providerAttachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string;
  disposition: "attachment" | "inline";
};

export type RemoteMessage = {
  providerMessageId: string;
  internetMessageId: string;
  threadId: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  sentAt: number | null;
  receivedAt: number;
  size: number;
  seen: boolean;
  flagged: boolean;
  text: string;
  html: string;
  bodyState: "ready" | "too_large" | "failed" | "pending";
  attachments: RemoteAttachment[];
  /** Folders (or labels) the message is in, with the provider's per-folder identity. */
  locations: {
    folderRemoteId: string;
    uid: number | null;
    uidValidity: number | null;
    modseq: string | null;
    flags: string[];
  }[];
};

/** What the connector needs to know about the account; the secret is already opened. */
export type ConnectorAccount = {
  id: string;
  userId: string;
  provider: "imap" | "gmail" | "microsoft";
  email: string;
  username: string;
  host: string;
  port: number;
  tls: boolean;
  /** SMTP submission server of an IMAP account (empty: the IMAP host). */
  smtpHost: string;
  smtpPort: number;
  historyDays: number;
  secret:
    | { kind: "password"; password: string }
    | { kind: "oauth"; accessToken: string; refreshToken: string; expiresAt: number; scope: string }
    | null;
};

/** The store and limits a sync works against (server/mail/store.ts and the worker). */
export type SyncContext = {
  policy: MailPolicy;
  /** Stop starting new batches after this moment; resume on the next run. */
  deadline: number;
  /** At most this many messages per run, so one mailbox cannot hold a worker. */
  maxMessages: number;
  folders: (remote: RemoteFolder[]) => Promise<Map<string, { id: string; syncEnabled: boolean }>>;
  state: (folderId: string | null) => Promise<SyncState>;
  saveState: (folderId: string | null, state: Partial<SyncState>) => Promise<void>;
  saveMessages: (messages: RemoteMessage[]) => Promise<number>;
  updateFlags: (
    folderId: string,
    items: { uid: number; uidValidity: number; flags: string[]; modseq: string | null }[],
  ) => Promise<void>;
  /** Mark locations gone: UIDs of a folder, or provider message ids (Gmail/Graph). */
  vanishUids: (folderId: string, uidValidity: number, uids: number[]) => Promise<void>;
  vanishMessages: (folderId: string | null, providerMessageIds: string[]) => Promise<void>;
  resetFolder: (folderId: string) => Promise<void>;
  localUids: (folderId: string, uidValidity: number) => Promise<number[]>;
  progress: (fields: { phase: string; processed: number }) => Promise<void>;
  /** A refreshed OAuth token to store. */
  saveTokens: (secret: NonNullable<ConnectorAccount["secret"]>) => Promise<void>;
};

export type SyncState = {
  uidValidity: number | null;
  lastUid: number;
  highestModseq: string | null;
  historyId: string | null;
  deltaLink: string | null;
  backfillDone: boolean;
  backfillCursor: string | null;
  reconciledAt: number | null;
};

export type SyncResult = { more: boolean; processed: number };

export type AttachmentSink = {
  /** Write one chunk; resolves when it is stored (backpressure). */
  write: (chunk: Uint8Array) => Promise<void>;
};

/** A composed message (RFC 5322 source) and who it goes to, Bcc included. */
export type OutgoingMessage = { raw: Buffer; from: string; recipients: string[] };

export interface MailConnector {
  /**
   * Send a message as this account. The provider keeps it in Sent (IMAP: appended to the Sent
   * folder; false when that copy could not be saved, the message itself went out).
   */
  send(message: OutgoingMessage): Promise<{ sentCopy: boolean }>;
  /**
   * Write read and flagged back to the server (IMAP \\Seen and \\Flagged, Gmail's UNREAD and
   * STARRED labels, Graph's isRead and flag), so the mail server shows what Grafito shows.
   */
  setFlags(
    target: { providerMessageId: string; locations: { folderRemoteId: string; uid: number }[] },
    changes: { seen?: boolean; flagged?: boolean },
  ): Promise<void>;
  /** Keep a message being written in the account's Drafts (RFC 5322 source). */
  saveDraft(raw: Buffer): Promise<void>;
  /** Sign in and check the account can be read. */
  test(): Promise<void>;
  /** One bounded pass: folders, new messages, flag changes, deletions. */
  sync(context: SyncContext): Promise<SyncResult>;
  /** Stream one attachment's bytes into the sink; returns the byte count. */
  fetchAttachment(
    message: { providerMessageId: string; uid: number | null; folderRemoteId: string | null },
    attachment: { providerAttachmentId: string },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number>;
  /** Stream the whole message as the server holds it (RFC 5322 source, for .eml). */
  fetchRaw(
    message: { providerMessageId: string; uid: number | null; folderRemoteId: string | null },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number>;
  close(): Promise<void>;
}
