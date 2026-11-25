import type { Sql } from "@/lib/db";
import type { MailAddress, SpecialUse } from "@/domain/mail/message";
import { freshToken, providerJson, providerSend } from "../oauth";
import {
  MailError,
  type AttachmentSink,
  type ConnectorAccount,
  type MailConnector,
  type OutgoingMessage,
  type RemoteAttachment,
  type RemoteFolder,
  type RemoteMessage,
  type SyncContext,
  type SyncResult,
} from "./types";

/**
 * Gmail through the Gmail API (read-only scope). Labels are folders, and a message is in as many
 * as it has labels. The first run lists the history window page by page (the page token is the
 * resume cursor) after taking the mailbox's current history id; later runs read the History API
 * from the stored id. An expired history id restarts the window, which the store makes idempotent.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

const SYSTEM: Record<string, SpecialUse> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  SPAM: "junk",
  TRASH: "trash",
  STARRED: "flagged",
};

const HIDDEN = /^(CATEGORY_|UNREAD$|IMPORTANT$|CHAT$|YELLOW_STAR$)/;

type Header = { name: string; value: string };
type Part = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
};
type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  sizeEstimate?: number;
  payload?: Part;
};

function header(headers: Header[] | undefined, name: string): string {
  return headers?.find((item) => item.name.toLowerCase() === name)?.value ?? "";
}

/** Addresses from a header such as `Ana <ana@x.org>, bob@y.org`. */
export function parseAddresses(value: string): MailAddress[] {
  const out: MailAddress[] = [];
  for (const raw of value.match(/("[^"]*"|[^,])+/g) ?? []) {
    const item = raw.trim();
    if (!item) continue;
    const angle = /^(.*)<([^>]+)>$/.exec(item);
    if (angle)
      out.push({
        name: (angle[1] ?? "").trim().replace(/^"|"$/g, ""),
        address: (angle[2] ?? "").trim(),
      });
    else if (item.includes("@")) out.push({ name: "", address: item });
  }
  return out.slice(0, 200);
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

export class GmailConnector implements MailConnector {
  constructor(
    private readonly sql: Sql,
    private readonly account: ConnectorAccount,
    private readonly saveTokens: SyncContext["saveTokens"] | null = null,
  ) {}

  private async token(context?: SyncContext): Promise<string> {
    const secret = this.account.secret;
    if (!secret || secret.kind !== "oauth")
      throw new MailError("auth", "La cuenta no está autorizada.");
    const save = context?.saveTokens ?? this.saveTokens ?? (async () => undefined);
    return freshToken(this.sql, "gmail", secret, save);
  }

  async test(): Promise<void> {
    await providerJson(`${API}/profile`, await this.token());
  }

  async close(): Promise<void> {}

  async send(message: OutgoingMessage): Promise<{ sentCopy: boolean }> {
    await providerSend(
      `${API}/messages/send`,
      await this.token(),
      JSON.stringify({ raw: message.raw.toString("base64url") }),
      "application/json",
    );
    return { sentCopy: true };
  }

  private async labels(token: string): Promise<RemoteFolder[]> {
    const answer = await providerJson<{ labels?: { id: string; name: string; type: string }[] }>(
      `${API}/labels`,
      token,
    );
    return (answer.labels ?? [])
      .filter((label) => !HIDDEN.test(label.id))
      .map((label) => ({
        remoteId: label.id,
        name:
          label.type === "system"
            ? label.id.charAt(0) + label.id.slice(1).toLowerCase()
            : label.name,
        path: label.name,
        parentRemoteId: null,
        specialUse: SYSTEM[label.id] ?? "",
      }));
  }

  private normalize(message: GmailMessage, maxBody: number): RemoteMessage {
    const headers = message.payload?.headers;
    let text = "";
    let html = "";
    let bodyState: RemoteMessage["bodyState"] = "ready";
    const attachments: RemoteAttachment[] = [];
    const walk = (part: Part | undefined) => {
      if (!part) return;
      if (part.parts?.length) {
        for (const child of part.parts) walk(child);
        return;
      }
      const type = (part.mimeType ?? "").toLowerCase();
      const disposition = header(part.headers, "content-disposition").toLowerCase();
      if (part.filename || part.body?.attachmentId) {
        const contentId = header(part.headers, "content-id").replace(/^<|>$/g, "");
        attachments.push({
          providerAttachmentId: part.body?.attachmentId ?? part.partId ?? "",
          filename: part.filename ?? "",
          contentType: type || "application/octet-stream",
          size: part.body?.size ?? 0,
          contentId,
          disposition:
            disposition.startsWith("inline") || (contentId && !disposition)
              ? "inline"
              : "attachment",
        });
        return;
      }
      if ((part.body?.size ?? 0) > maxBody) {
        bodyState = "too_large";
        return;
      }
      if (type === "text/plain" && !text) text = decode(part.body?.data);
      else if (type === "text/html" && !html) html = decode(part.body?.data);
    };
    walk(message.payload);
    const labels = message.labelIds ?? [];
    const received = Number(message.internalDate ?? Date.now());
    const date = Date.parse(header(headers, "date"));
    return {
      providerMessageId: message.id,
      internetMessageId: header(headers, "message-id").slice(0, 300),
      threadId: message.threadId ?? "",
      subject: header(headers, "subject").slice(0, 1000),
      from: parseAddresses(header(headers, "from"))[0] ?? { name: "", address: "" },
      to: parseAddresses(header(headers, "to")),
      cc: parseAddresses(header(headers, "cc")),
      bcc: parseAddresses(header(headers, "bcc")),
      replyTo: parseAddresses(header(headers, "reply-to")),
      sentAt: Number.isFinite(date) ? date : null,
      receivedAt: Number.isFinite(received) ? received : Date.now(),
      size: message.sizeEstimate ?? 0,
      seen: !labels.includes("UNREAD"),
      flagged: labels.includes("STARRED"),
      text,
      html,
      bodyState,
      attachments: attachments.filter((item) => item.providerAttachmentId),
      locations: labels
        .filter((label) => !HIDDEN.test(label))
        .map((label) => ({
          folderRemoteId: label,
          uid: null,
          uidValidity: null,
          modseq: null,
          flags: [],
        })),
    };
  }

  private async fetchMessages(token: string, ids: string[], context: SyncContext): Promise<number> {
    const messages: RemoteMessage[] = [];
    for (const id of ids) {
      try {
        const message = await providerJson<GmailMessage>(
          `${API}/messages/${encodeURIComponent(id)}?format=full`,
          token,
        );
        messages.push(this.normalize(message, context.policy.maxBodyBytes));
      } catch (error) {
        // Deleted between the listing and now.
        if (error instanceof MailError && error.kind === "cursor") continue;
        throw error;
      }
    }
    return context.saveMessages(messages);
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    const token = await this.token(context);
    await context.folders(await this.labels(token));
    let state = await context.state(null);
    let processed = 0;
    if (!state.historyId) {
      const profile = await providerJson<{ historyId: string }>(`${API}/profile`, token);
      await context.saveState(null, {
        historyId: profile.historyId,
        backfillDone: false,
        backfillCursor: null,
      });
      state = await context.state(null);
    }
    // Changes since the stored history id.
    if (state.backfillDone) {
      let page: string | undefined;
      let latest = state.historyId;
      try {
        do {
          const params = new URLSearchParams({
            startHistoryId: state.historyId ?? "",
            maxResults: "200",
          });
          if (page) params.set("pageToken", page);
          const answer = await providerJson<{
            history?: {
              messagesAdded?: { message: { id: string } }[];
              messagesDeleted?: { message: { id: string } }[];
              labelsAdded?: { message: { id: string } }[];
              labelsRemoved?: { message: { id: string } }[];
            }[];
            historyId?: string;
            nextPageToken?: string;
          }>(`${API}/history?${params}`, token);
          const changed = new Set<string>();
          const deleted = new Set<string>();
          for (const item of answer.history ?? []) {
            for (const entry of item.messagesAdded ?? []) changed.add(entry.message.id);
            for (const entry of item.labelsAdded ?? []) changed.add(entry.message.id);
            for (const entry of item.labelsRemoved ?? []) changed.add(entry.message.id);
            for (const entry of item.messagesDeleted ?? []) deleted.add(entry.message.id);
          }
          for (const id of deleted) changed.delete(id);
          if (deleted.size) await context.vanishMessages(null, [...deleted]);
          processed += await this.fetchMessages(token, [...changed], context);
          latest = answer.historyId ?? latest;
          page = answer.nextPageToken;
          if (Date.now() > context.deadline || processed >= context.maxMessages) break;
        } while (page);
      } catch (error) {
        if (error instanceof MailError && error.kind === "cursor") {
          // History too old: start the window again (stored messages are updated, not duplicated).
          await context.saveState(null, {
            historyId: null,
            backfillDone: false,
            backfillCursor: null,
          });
          return { more: true, processed };
        }
        throw error;
      }
      if (!page) await context.saveState(null, { historyId: latest });
      return { more: Boolean(page), processed };
    }
    // The initial window, page by page.
    const after = Math.floor((Date.now() - this.account.historyDays * 86_400_000) / 1000);
    let cursor = state.backfillCursor ?? undefined;
    let more = true;
    while (Date.now() < context.deadline && processed < context.maxMessages) {
      const params = new URLSearchParams({
        q: `after:${after}`,
        maxResults: "50",
        includeSpamTrash: "true",
      });
      if (cursor) params.set("pageToken", cursor);
      const answer = await providerJson<{ messages?: { id: string }[]; nextPageToken?: string }>(
        `${API}/messages?${params}`,
        token,
      );
      processed += await this.fetchMessages(
        token,
        (answer.messages ?? []).map((item) => item.id),
        context,
      );
      cursor = answer.nextPageToken;
      await context.saveState(null, { backfillCursor: cursor ?? null });
      await context.progress({ phase: "initial", processed });
      if (!cursor) {
        await context.saveState(null, { backfillDone: true, backfillCursor: null });
        more = false;
        break;
      }
    }
    return { more, processed };
  }

  async fetchRaw(
    message: { providerMessageId: string },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number> {
    const answer = await providerJson<{ raw?: string }>(
      `${API}/messages/${encodeURIComponent(message.providerMessageId)}?format=raw`,
      await this.token(),
    );
    const bytes = Buffer.from(answer.raw ?? "", "base64url");
    if (bytes.byteLength > maxBytes)
      throw new MailError("permanent", "El mensaje supera el tamaño permitido.");
    await sink.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return bytes.byteLength;
  }

  async fetchAttachment(
    message: { providerMessageId: string },
    attachment: { providerAttachmentId: string },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number> {
    const answer = await providerJson<{ data?: string; size?: number }>(
      `${API}/messages/${encodeURIComponent(message.providerMessageId)}/attachments/${encodeURIComponent(attachment.providerAttachmentId)}`,
      await this.token(),
    );
    const bytes = Buffer.from(answer.data ?? "", "base64url");
    if (bytes.byteLength > maxBytes)
      throw new MailError("permanent", "El adjunto supera el tamaño permitido.");
    for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024)
      await sink.write(
        new Uint8Array(
          bytes.buffer,
          bytes.byteOffset + offset,
          Math.min(1024 * 1024, bytes.byteLength - offset),
        ),
      );
    return bytes.byteLength;
  }
}
