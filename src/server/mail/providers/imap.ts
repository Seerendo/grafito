import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { resolveSmtpTarget } from "../settings";
import { folderPlan, specialUseOf, vanished, type MailAddress } from "@/domain/mail/message";
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
 * IMAP over TLS (port 993) or STARTTLS (143, never cleartext), for Zimbra, Exchange with IMAP and
 * any standard server. The connection goes to the address the host check approved, with the host
 * name kept for TLS so the certificate is still validated against it.
 *
 * Per folder: UIDVALIDITY decides whether stored UIDs still mean anything; new messages are
 * those above the last confirmed UID; the initial window is fetched newest first and resumes from
 * its cursor; flag changes come from CONDSTORE (CHANGEDSINCE) when the server has it, otherwise
 * from the periodic reconciliation, which also finds messages deleted on the server.
 */

const BATCH = 40;
const RECONCILE_MS = 30 * 60 * 1000;

function classify(error: unknown): MailError {
  if (error instanceof MailError) return error;
  const value = error as {
    authenticationFailed?: boolean;
    code?: string;
    message?: string;
    responseText?: string;
  };
  const text = `${value?.code ?? ""} ${value?.message ?? ""} ${value?.responseText ?? ""}`;
  if (
    value?.authenticationFailed ||
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(text)
  )
    return new MailError("auth", "El servidor rechazó el usuario o la contraseña.");
  if (/CERT|self.signed|unable to verify|altnames|UNABLE_TO_GET_ISSUER/i.test(text))
    return new MailError(
      "connection",
      "El certificado del servidor no es válido para ese nombre. Grafito no se conecta sin verificarlo.",
    );
  if (/ENOTFOUND|EAI_AGAIN/.test(text))
    return new MailError("connection", "No se encontró el servidor.");
  if (/ECONNREFUSED/.test(text))
    return new MailError("connection", "El servidor rechazó la conexión.");
  if (/ETIMEDOUT|timeout|Timed out/i.test(text))
    return new MailError("connection", "El servidor no respondió a tiempo.");
  if (/ECONNRESET|EPIPE|closed/i.test(text))
    return new MailError("connection", "Se cortó la conexión con el servidor.");
  if (/STARTTLS/i.test(text))
    return new MailError(
      "connection",
      "El servidor no ofrece STARTTLS: Grafito no envía la contraseña sin cifrar.",
    );
  return new MailError("temporary", "El servidor de correo devolvió un error.");
}

function classifySmtp(error: unknown): MailError {
  const value = error as { code?: string; responseCode?: number; message?: string };
  if (value?.code === "EAUTH")
    return new MailError("auth", "El servidor de salida rechazó el usuario o la contraseña.");
  if (value?.code === "EENVELOPE" || (value?.responseCode ?? 0) === 550)
    return new MailError("permanent", "El servidor de salida rechazó algún destinatario.");
  if ((value?.responseCode ?? 0) === 552)
    return new MailError("permanent", "El servidor de salida rechazó el tamaño del mensaje.");
  if (
    value?.code === "EMESSAGE" ||
    ((value?.responseCode ?? 0) >= 500 && value?.code !== "ECONNECTION")
  )
    return new MailError("permanent", "El servidor de salida rechazó el mensaje.");
  const found = classify(error);
  return found.kind === "temporary"
    ? new MailError("temporary", "El servidor de salida devolvió un error.")
    : found;
}

function address(list: { name?: string; address?: string }[] | undefined): MailAddress[] {
  return (list ?? [])
    .filter((item) => item.address)
    .map((item) => ({ name: (item.name ?? "").trim(), address: (item.address ?? "").trim() }))
    .slice(0, 200);
}

type Parts = {
  text: { part: string; size: number } | null;
  html: { part: string; size: number } | null;
  attachments: RemoteAttachment[];
};

/** Walk a body structure: the first readable text and HTML, and everything else as attachments. */
export function partsOf(node: MessageStructureObject | undefined): Parts {
  const found: Parts = { text: null, html: null, attachments: [] };
  const walk = (item: MessageStructureObject | undefined, inAlternative: boolean) => {
    if (!item) return;
    const type = (item.type ?? "").toLowerCase();
    if (type.startsWith("multipart/")) {
      for (const child of item.childNodes ?? [])
        walk(child, type === "multipart/alternative" || inAlternative);
      return;
    }
    const part = item.part ?? "1";
    const filename = item.dispositionParameters?.filename ?? item.parameters?.name ?? "";
    const disposition = (item.disposition ?? "").toLowerCase();
    const isAttachment =
      disposition === "attachment" || Boolean(filename && disposition !== "inline");
    if (!isAttachment && type === "text/plain" && !found.text) {
      found.text = { part, size: item.size ?? 0 };
      return;
    }
    if (!isAttachment && type === "text/html" && !found.html) {
      found.html = { part, size: item.size ?? 0 };
      return;
    }
    if (type === "message/rfc822" && !filename) {
      // A forwarded message: kept as an .eml attachment.
    }
    found.attachments.push({
      providerAttachmentId: part,
      filename:
        filename ||
        (type === "message/rfc822"
          ? "mensaje.eml"
          : type === "text/calendar"
            ? "invitacion.ics"
            : ""),
      contentType: type || "application/octet-stream",
      size: item.size ?? 0,
      contentId: (item.id ?? "").replace(/^<|>$/g, ""),
      disposition: disposition === "inline" || (!filename && item.id) ? "inline" : "attachment",
    });
    void inAlternative;
  };
  walk(node, false);
  return found;
}

async function readText(content: AsyncIterable<Buffer | string>, max: number): Promise<string> {
  let out = "";
  for await (const chunk of content) {
    out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (out.length > max) return out.slice(0, max);
  }
  return out;
}

export class ImapConnector implements MailConnector {
  private client: ImapFlow | null = null;
  private condstore = false;

  constructor(
    private readonly account: ConnectorAccount,
    /** The address the host check approved. */
    private readonly address: string,
  ) {}

  private async open(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    const secret = this.account.secret;
    if (!secret) throw new MailError("auth", "Falta la contraseña de la cuenta.");
    const implicit = this.account.port === 993;
    const client = new ImapFlow({
      host: this.address,
      servername: this.account.host,
      port: this.account.port,
      secure: implicit,
      ...(implicit ? {} : { doSTARTTLS: true }),
      auth:
        secret.kind === "password"
          ? { user: this.account.username || this.account.email, pass: secret.password }
          : { user: this.account.username || this.account.email, accessToken: secret.accessToken },
      logger: false,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      disableAutoIdle: true,
      qresync: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 90_000,
      clientInfo: { name: "Grafito" },
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch (error) {
      throw classify(error);
    }
    this.condstore = Boolean(
      client.enabled?.has("CONDSTORE") || client.capabilities?.has("CONDSTORE"),
    );
    this.client = client;
    return client;
  }

  async test(): Promise<void> {
    const client = await this.open();
    try {
      await client.mailboxOpen("INBOX", { readOnly: true });
    } catch (error) {
      throw classify(error);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await client.logout().catch(() => client.close());
  }

  /**
   * Send through the account's SMTP server (465 TLS or 587 STARTTLS, the same host check as IMAP,
   * certificate always validated), then keep a copy in the server's Sent folder.
   */
  async send(message: OutgoingMessage): Promise<{ sentCopy: boolean }> {
    const secret = this.account.secret;
    if (!secret || secret.kind !== "password")
      throw new MailError("auth", "Falta la contraseña de la cuenta.");
    const host = (this.account.smtpHost || this.account.host).trim().toLowerCase();
    const port = this.account.smtpPort || 587;
    const target = await resolveSmtpTarget(host, port);
    if (!target.ok) throw new MailError("permanent", target.error);
    const { createTransport } = await import("nodemailer");
    const transport = createTransport({
      host: target.address,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      tls: { servername: host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: { user: this.account.username || this.account.email, pass: secret.password },
      name: "grafito",
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 120_000,
    });
    try {
      await transport.sendMail({
        envelope: { from: message.from, to: message.recipients },
        raw: message.raw,
      });
    } catch (error) {
      throw classifySmtp(error);
    } finally {
      transport.close();
    }
    try {
      const client = await this.open();
      const sent = (await this.folders(client)).find((item) => item.specialUse === "sent");
      if (!sent) return { sentCopy: false };
      await client.append(sent.path, message.raw, ["\\Seen"]);
      return { sentCopy: true };
    } catch {
      return { sentCopy: false };
    }
  }

  async saveDraft(raw: Buffer): Promise<void> {
    const client = await this.open();
    const drafts = (await this.folders(client)).find((item) => item.specialUse === "drafts");
    if (!drafts) throw new MailError("permanent", "La cuenta no tiene carpeta de borradores.");
    try {
      await client.append(drafts.path, raw, ["\\Draft", "\\Seen"]);
    } catch (error) {
      throw classify(error);
    }
  }

  private async folders(client: ImapFlow): Promise<RemoteFolder[]> {
    const listed = await client.list();
    return listed
      .filter((item) => !item.flags?.has("\\Noselect") && !item.flags?.has("\\NonExistent"))
      .map((item) => {
        const delimiter = item.delimiter || "/";
        const segments = item.path.split(delimiter);
        return {
          remoteId: item.path,
          name: item.name || segments[segments.length - 1] || item.path,
          path: item.path,
          parentRemoteId: segments.length > 1 ? segments.slice(0, -1).join(delimiter) : null,
          specialUse: specialUseOf(item.path, item.specialUse, delimiter),
        };
      });
  }

  async sync(context: SyncContext): Promise<SyncResult> {
    try {
      const client = await this.open();
      const remote = await this.folders(client);
      const map = await context.folders(remote);
      const order = [...remote].sort(
        (a, b) => Number(b.specialUse === "inbox") - Number(a.specialUse === "inbox"),
      );
      let processed = 0;
      let more = false;
      for (const folder of order) {
        const local = map.get(folder.remoteId);
        if (!local?.syncEnabled) continue;
        if (Date.now() > context.deadline || processed >= context.maxMessages) {
          more = true;
          break;
        }
        const result = await this.syncFolder(client, context, local.id, folder.path, processed);
        processed += result.processed;
        if (result.more) more = true;
      }
      return { more, processed };
    } catch (error) {
      throw classify(error);
    }
  }

  private async syncFolder(
    client: ImapFlow,
    context: SyncContext,
    folderId: string,
    path: string,
    alreadyProcessed: number,
  ): Promise<SyncResult> {
    const mailbox = await client.mailboxOpen(path, { readOnly: true });
    const validity = Number(mailbox.uidValidity);
    let state = await context.state(folderId);
    const plan = folderPlan({
      storedValidity: state.uidValidity,
      serverValidity: validity,
      lastUid: state.lastUid,
      backfillDone: state.backfillDone,
    });
    if (plan.reset) {
      await context.resetFolder(folderId);
      state = await context.state(folderId);
    }
    let processed = 0;
    const budget = () => context.maxMessages - alreadyProcessed - processed;
    const timeLeft = () => Date.now() < context.deadline;

    // First visit: everything up to the current top belongs to the initial window, and anything
    // that arrives later is "new". Both are confirmed batch by batch.
    if (state.uidValidity === null || plan.reset || (state.lastUid === 0 && !state.backfillDone)) {
      const top = Math.max(0, Number(mailbox.uidNext ?? 1) - 1);
      await context.saveState(folderId, {
        uidValidity: validity,
        lastUid: top,
        backfillDone: false,
        backfillCursor: null,
        highestModseq: mailbox.highestModseq ? String(mailbox.highestModseq) : null,
      });
      state = await context.state(folderId);
    }

    // New messages since the last confirmed UID.
    const newer = ((await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })) || [])
      .filter((uid) => uid > state.lastUid)
      .sort((a, b) => a - b);
    let lastUid = state.lastUid;
    while (newer.length > 0 && timeLeft() && budget() > 0) {
      const batch = newer.splice(0, Math.min(BATCH, budget()));
      processed += await this.fetchBatch(client, context, folderId, path, validity, batch);
      lastUid = Math.max(lastUid, ...batch);
      await context.saveState(folderId, { lastUid });
    }
    const pendingNew = newer.length > 0;

    // The initial window, newest first, resuming below the cursor.
    let backfillMore = false;
    if (!state.backfillDone && timeLeft() && budget() > 0) {
      const since =
        this.account.historyDays > 0
          ? new Date(Date.now() - this.account.historyDays * 86_400_000)
          : null;
      const cursor = state.backfillCursor ? Number(state.backfillCursor) : Infinity;
      const window = ((await client.search(since ? { since } : { all: true }, { uid: true })) || [])
        .filter((uid) => uid <= state.lastUid && uid < cursor)
        .sort((a, b) => b - a);
      while (window.length > 0 && timeLeft() && budget() > 0) {
        const batch = window.splice(0, Math.min(BATCH, budget()));
        processed += await this.fetchBatch(client, context, folderId, path, validity, batch);
        await context.saveState(folderId, { backfillCursor: String(Math.min(...batch)) });
        await context.progress({ phase: "initial", processed });
      }
      if (window.length === 0) await context.saveState(folderId, { backfillDone: true });
      else backfillMore = true;
    }

    // Flag changes since the last MODSEQ (CONDSTORE).
    const highest = mailbox.highestModseq ? String(mailbox.highestModseq) : null;
    if (
      this.condstore &&
      highest &&
      state.highestModseq &&
      highest !== state.highestModseq &&
      timeLeft()
    ) {
      const changed: {
        uid: number;
        uidValidity: number;
        flags: string[];
        modseq: string | null;
      }[] = [];
      for await (const message of client.fetch(
        "1:*",
        { uid: true, flags: true },
        { uid: true, changedSince: BigInt(state.highestModseq) },
      )) {
        if (message.uid > lastUid) continue;
        changed.push({
          uid: message.uid,
          uidValidity: validity,
          flags: [...(message.flags ?? [])],
          modseq: message.modseq ? String(message.modseq) : null,
        });
      }
      await context.updateFlags(folderId, changed);
    }
    if (highest) await context.saveState(folderId, { highestModseq: highest });

    // Reconciliation: messages deleted on the server, and flags when there is no CONDSTORE.
    if (timeLeft() && (!state.reconciledAt || Date.now() - state.reconciledAt > RECONCILE_MS)) {
      const remoteUids = (await client.search({ all: true }, { uid: true })) || [];
      const local = await context.localUids(folderId, validity);
      const gone = vanished(local, remoteUids);
      if (gone.length) await context.vanishUids(folderId, validity, gone);
      if (!this.condstore && local.length) {
        const present = new Set(remoteUids);
        const keep = local.filter((uid) => present.has(uid));
        for (let index = 0; index < keep.length && timeLeft(); index += 1000) {
          const slice = keep.slice(index, index + 1000);
          const items: {
            uid: number;
            uidValidity: number;
            flags: string[];
            modseq: string | null;
          }[] = [];
          for await (const message of client.fetch(
            slice.join(","),
            { uid: true, flags: true },
            { uid: true },
          ))
            items.push({
              uid: message.uid,
              uidValidity: validity,
              flags: [...(message.flags ?? [])],
              modseq: null,
            });
          await context.updateFlags(folderId, items);
        }
      }
      await context.saveState(folderId, { reconciledAt: Date.now() });
    }
    return { more: pendingNew || backfillMore, processed };
  }

  private async fetchBatch(
    client: ImapFlow,
    context: SyncContext,
    folderId: string,
    path: string,
    validity: number,
    uids: number[],
  ): Promise<number> {
    const fetched: FetchMessageObject[] = [];
    for await (const message of client.fetch(
      uids.join(","),
      {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
      },
      { uid: true },
    ))
      fetched.push(message);
    const maxBody = context.policy.maxBodyBytes;
    const messages: RemoteMessage[] = [];
    for (const message of fetched) {
      const parts = partsOf(message.bodyStructure);
      let text = "";
      let html = "";
      let bodyState: RemoteMessage["bodyState"] = "ready";
      try {
        for (const [kind, node] of [
          ["text", parts.text],
          ["html", parts.html],
        ] as const) {
          if (!node) continue;
          // Transfer encoding makes the stored size about a third larger than the text.
          if (node.size > maxBody * 1.4) {
            bodyState = "too_large";
            continue;
          }
          const download = await client.download(String(message.uid), node.part, {
            uid: true,
            maxBytes: Math.ceil(maxBody * 1.4),
          });
          const value = await readText(download.content as AsyncIterable<Buffer>, maxBody);
          if (kind === "text") text = value;
          else html = value;
        }
      } catch {
        bodyState = "failed";
      }
      const flags = [...(message.flags ?? [])];
      const envelope = message.envelope;
      const received = message.internalDate ? new Date(message.internalDate).getTime() : Date.now();
      messages.push({
        providerMessageId: `${folderId}:${validity}:${message.uid}`,
        internetMessageId: (envelope?.messageId ?? "").slice(0, 300),
        threadId: "",
        subject: (envelope?.subject ?? "").slice(0, 1000),
        from: address(envelope?.from)[0] ??
          address(envelope?.sender)[0] ?? { name: "", address: "" },
        to: address(envelope?.to),
        cc: address(envelope?.cc),
        bcc: address(envelope?.bcc),
        replyTo: address(envelope?.replyTo),
        sentAt: envelope?.date ? new Date(envelope.date).getTime() || null : null,
        receivedAt: Number.isFinite(received) ? received : Date.now(),
        size: message.size ?? 0,
        seen: flags.includes("\\Seen"),
        flagged: flags.includes("\\Flagged"),
        text,
        html,
        bodyState,
        attachments: parts.attachments,
        locations: [
          {
            folderRemoteId: path,
            uid: message.uid,
            uidValidity: validity,
            modseq: message.modseq ? String(message.modseq) : null,
            flags,
          },
        ],
      });
    }
    return context.saveMessages(messages);
  }

  async fetchRaw(
    message: { providerMessageId: string; uid: number | null; folderRemoteId: string | null },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number> {
    if (!message.uid || !message.folderRemoteId)
      throw new MailError("permanent", "El mensaje ya no está en el servidor.");
    const validity = Number(message.providerMessageId.split(":")[1]);
    try {
      const client = await this.open();
      const mailbox = await client.mailboxOpen(message.folderRemoteId, { readOnly: true });
      if (Number(mailbox.uidValidity) !== validity)
        throw new MailError("permanent", "El mensaje ya no está en el servidor.");
      const download = await client.download(String(message.uid), undefined, {
        uid: true,
        maxBytes: maxBytes + 1,
      });
      let total = 0;
      for await (const chunk of download.content as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (total > maxBytes)
          throw new MailError("permanent", "El mensaje supera el tamaño permitido.");
        await sink.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      return total;
    } catch (error) {
      throw classify(error);
    }
  }

  async fetchAttachment(
    message: { providerMessageId: string; uid: number | null; folderRemoteId: string | null },
    attachment: { providerAttachmentId: string },
    sink: AttachmentSink,
    maxBytes: number,
  ): Promise<number> {
    if (!message.uid || !message.folderRemoteId)
      throw new MailError("permanent", "El mensaje ya no está en el servidor.");
    const validity = Number(message.providerMessageId.split(":")[1]);
    try {
      const client = await this.open();
      const mailbox = await client.mailboxOpen(message.folderRemoteId, { readOnly: true });
      if (Number(mailbox.uidValidity) !== validity)
        throw new MailError("permanent", "El mensaje ya no está en el servidor.");
      const download = await client.download(String(message.uid), attachment.providerAttachmentId, {
        uid: true,
        maxBytes: maxBytes + 1,
      });
      let total = 0;
      for await (const chunk of download.content as AsyncIterable<Buffer>) {
        total += chunk.byteLength;
        if (total > maxBytes)
          throw new MailError("permanent", "El adjunto supera el tamaño permitido.");
        await sink.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      return total;
    } catch (error) {
      throw classify(error);
    }
  }
}
