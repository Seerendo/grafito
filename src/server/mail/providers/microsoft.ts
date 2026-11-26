import type { Sql } from "@/lib/db";
import { htmlToText, specialUseOf, type MailAddress, type SpecialUse } from "@/domain/mail/message";
import { freshToken, providerJson, providerSend } from "../oauth";
import {
  MailError,
  retryAfterMs,
  type AttachmentSink,
  type ConnectorAccount,
  type MailConnector,
  type OutgoingMessage,
  type RemoteFolder,
  type RemoteMessage,
  type SyncContext,
  type SyncResult,
} from "./types";

/**
 * Microsoft 365 and Outlook.com through Microsoft Graph (Mail.Read). Each folder keeps its own
 * delta link: the first round follows next links over the history window (the next link is the
 * resume cursor), and the delta link it ends with brings later changes and removals. A delta link
 * the service no longer accepts restarts that folder's window.
 */

const API = "https://graph.microsoft.com/v1.0/me";
const WELL_KNOWN: [string, SpecialUse][] = [
  ["inbox", "inbox"],
  ["sentitems", "sent"],
  ["drafts", "drafts"],
  ["archive", "archive"],
  ["junkemail", "junk"],
  ["deleteditems", "trash"],
];
const SELECT =
  "id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,sentDateTime,receivedDateTime,isRead,flag,hasAttachments,body,parentFolderId";

type Recipient = { emailAddress?: { name?: string; address?: string } };
type GraphMessage = {
  id: string;
  "@removed"?: unknown;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  replyTo?: Recipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
};

function people(list: Recipient[] | undefined): MailAddress[] {
  return (list ?? [])
    .map((item) => ({
      name: item.emailAddress?.name ?? "",
      address: item.emailAddress?.address ?? "",
    }))
    .filter((item) => item.address)
    .slice(0, 200);
}

export class MicrosoftConnector implements MailConnector {
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
    return freshToken(this.sql, "microsoft", secret, save);
  }

  async test(): Promise<void> {
    await providerJson(`${API}/mailFolders/inbox?$select=id`, await this.token());
  }

  async close(): Promise<void> {}

  async setFlags(
    target: { providerMessageId: string },
    changes: { seen?: boolean; flagged?: boolean },
  ): Promise<void> {
    await providerSend(
      `${API}/messages/${encodeURIComponent(target.providerMessageId)}`,
      await this.token(),
      JSON.stringify({
        ...(changes.seen !== undefined ? { isRead: changes.seen } : {}),
        ...(changes.flagged !== undefined
          ? { flag: { flagStatus: changes.flagged ? "flagged" : "notFlagged" } }
          : {}),
      }),
      "application/json",
      "PATCH",
    );
  }

  /** A MIME message posted to /messages becomes a draft. */
  async saveDraft(raw: Buffer): Promise<void> {
    await providerSend(`${API}/messages`, await this.token(), raw.toString("base64"), "text/plain");
  }

  /** Graph takes the MIME source as base64 text and saves a copy in Sent Items. */
  async send(message: OutgoingMessage): Promise<{ sentCopy: boolean }> {
    await providerSend(
      `${API}/sendMail`,
      await this.token(),
      message.raw.toString("base64"),
      "text/plain",
    );
    return { sentCopy: true };
  }

  private async folders(token: string): Promise<RemoteFolder[]> {
    const special = new Map<string, SpecialUse>();
    for (const [name, use] of WELL_KNOWN) {
      try {
        const folder = await providerJson<{ id: string }>(
          `${API}/mailFolders/${name}?$select=id`,
          token,
        );
        special.set(folder.id, use);
      } catch {
        /* not every mailbox has an archive folder */
      }
    }
    const out: RemoteFolder[] = [];
    const visit = async (url: string, parent: string | null, prefix: string, depth: number) => {
      let next: string | undefined = url;
      while (next) {
        const page: {
          value?: { id: string; displayName: string; childFolderCount?: number }[];
          "@odata.nextLink"?: string;
        } = await providerJson(next, token);
        for (const folder of page.value ?? []) {
          const path = prefix ? `${prefix}/${folder.displayName}` : folder.displayName;
          out.push({
            remoteId: folder.id,
            name: folder.displayName,
            path,
            parentRemoteId: parent,
            specialUse: special.get(folder.id) ?? specialUseOf(path, null),
          });
          if ((folder.childFolderCount ?? 0) > 0 && depth < 4)
            await visit(
              `${API}/mailFolders/${folder.id}/childFolders?$top=100`,
              folder.id,
              path,
              depth + 1,
            );
        }
        next = page["@odata.nextLink"];
      }
    };
    await visit(`${API}/mailFolders?$top=100`, null, "", 0);
    return out;
  }

  private async normalize(
    token: string,
    folderId: string,
    message: GraphMessage,
    maxBody: number,
  ): Promise<RemoteMessage> {
    const content = message.body?.content ?? "";
    const isHtml = (message.body?.contentType ?? "").toLowerCase() === "html";
    const tooLarge = content.length > maxBody;
    const attachments: RemoteMessage["attachments"] = [];
    if (message.hasAttachments || /cid:/i.test(content)) {
      const answer = await providerJson<{
        value?: {
          id: string;
          name?: string;
          contentType?: string;
          size?: number;
          isInline?: boolean;
          contentId?: string;
        }[];
      }>(
        `${API}/messages/${encodeURIComponent(message.id)}/attachments?$select=id,name,contentType,size,isInline,contentId`,
        token,
      );
      for (const item of answer.value ?? [])
        attachments.push({
          providerAttachmentId: item.id,
          filename: item.name ?? "",
          contentType: item.contentType ?? "application/octet-stream",
          size: item.size ?? 0,
          contentId: (item.contentId ?? "").replace(/^<|>$/g, ""),
          disposition: item.isInline ? "inline" : "attachment",
        });
    }
    const flagged = message.flag?.flagStatus === "flagged";
    return {
      providerMessageId: message.id,
      internetMessageId: (message.internetMessageId ?? "").slice(0, 300),
      threadId: message.conversationId ?? "",
      subject: (message.subject ?? "").slice(0, 1000),
      from: people(message.from ? [message.from] : [])[0] ?? { name: "", address: "" },
      to: people(message.toRecipients),
      cc: people(message.ccRecipients),
      bcc: people(message.bccRecipients),
      replyTo: people(message.replyTo),
      sentAt: message.sentDateTime ? Date.parse(message.sentDateTime) || null : null,
      receivedAt: Date.parse(message.receivedDateTime ?? "") || Date.now(),
      size: content.length,
      seen: message.isRead === true,
      flagged,
      text: tooLarge ? "" : isHtml ? htmlToText(content) : content,
      html: tooLarge || !isHtml ? "" : content,
      bodyState: tooLarge ? "too_large" : "ready",
      attachments,
      locations: [
        { folderRemoteId: folderId, uid: null, uidValidity: null, modseq: null, flags: [] },
      ],
    };
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    const token = await this.token(context);
    const remote = await this.folders(token);
    const map = await context.folders(remote);
    let processed = 0;
    let more = false;
    const order = [...remote].sort(
      (a, b) => Number(b.specialUse === "inbox") - Number(a.specialUse === "inbox"),
    );
    for (const folder of order) {
      const local = map.get(folder.remoteId);
      if (!local?.syncEnabled) continue;
      if (Date.now() > context.deadline || processed >= context.maxMessages) {
        more = true;
        break;
      }
      const state = await context.state(local.id);
      const since = new Date(Date.now() - this.account.historyDays * 86_400_000).toISOString();
      let url =
        state.backfillCursor ??
        state.deltaLink ??
        `${API}/mailFolders/${encodeURIComponent(folder.remoteId)}/messages/delta?$select=${SELECT}${this.account.historyDays > 0 ? `&$filter=receivedDateTime+ge+${since}` : ""}`;
      try {
        while (url && Date.now() < context.deadline && processed < context.maxMessages) {
          const page: {
            value?: GraphMessage[];
            "@odata.nextLink"?: string;
            "@odata.deltaLink"?: string;
          } = await providerJson(url, token, {
            headers: {
              prefer:
                'odata.maxpagesize=50, outlook.body-content-type="html", IdType="ImmutableId"',
            },
          });
          const removed = (page.value ?? [])
            .filter((item) => item["@removed"])
            .map((item) => item.id);
          if (removed.length) await context.vanishMessages(local.id, removed);
          const messages: RemoteMessage[] = [];
          for (const item of page.value ?? [])
            if (!item["@removed"])
              messages.push(
                await this.normalize(token, folder.remoteId, item, context.policy.maxBodyBytes),
              );
          processed += await context.saveMessages(messages);
          if (page["@odata.nextLink"]) {
            url = page["@odata.nextLink"];
            await context.saveState(local.id, { backfillCursor: url });
          } else {
            await context.saveState(local.id, {
              backfillCursor: null,
              backfillDone: true,
              deltaLink: page["@odata.deltaLink"] ?? state.deltaLink,
            });
            url = "";
          }
          await context.progress({
            phase: state.backfillDone ? "incremental" : "initial",
            processed,
          });
        }
        if (url) more = true;
      } catch (error) {
        if (error instanceof MailError && error.kind === "cursor") {
          await context.saveState(local.id, {
            deltaLink: null,
            backfillCursor: null,
            backfillDone: false,
          });
          more = true;
          continue;
        }
        throw error;
      }
    }
    return { more, processed };
  }

  async fetchRaw(
    message: { providerMessageId: string },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number> {
    return this.stream(
      `${API}/messages/${encodeURIComponent(message.providerMessageId)}/$value`,
      sink,
      maxBytes,
    );
  }

  private async stream(url: string, sink: AttachmentSink, maxBytes: number): Promise<number> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${await this.token()}`, prefer: 'IdType="ImmutableId"' },
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MailError("connection", "No se pudo contactar con el proveedor.");
    }
    if (response.status === 429)
      throw new MailError(
        "rate_limited",
        "El proveedor pidió esperar.",
        retryAfterMs(response.headers.get("retry-after")),
      );
    if (!response.ok || !response.body)
      throw new MailError("temporary", `El proveedor respondió ${response.status}.`);
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes)
        throw new MailError("permanent", "El archivo supera el tamaño permitido.");
      await sink.write(chunk);
    }
    return total;
  }

  async fetchAttachment(
    message: { providerMessageId: string },
    attachment: { providerAttachmentId: string },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number> {
    return this.stream(
      `${API}/messages/${encodeURIComponent(message.providerMessageId)}/attachments/${encodeURIComponent(attachment.providerAttachmentId)}/$value`,
      sink,
      maxBytes,
    );
  }
}
