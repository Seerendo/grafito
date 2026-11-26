import { createServerFn } from "@tanstack/react-start";
import { readBlob } from "@/server/blobs";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import type { Sql } from "@/lib/db";
import { recordAudit } from "@/server/audit";
import { extensionActive } from "@/server/extensions";
import { signToken } from "@/server/file-links";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile, type UserProfile } from "@/server/profile";
import { listPortfolios, VaultError } from "@/server/vault";
import { sharedWith } from "@/server/share";
import {
  createImapAccount,
  saveOAuthAccount,
  deleteLocalData,
  disconnectAccount,
  listAccounts,
  setFolderSync,
  syncNow,
  updateAccount,
} from "@/server/mail/accounts";
import { archiveAttachments, archiveEml, archiveMessage } from "@/server/mail/archive";
import { attachmentChoices, discardUploads, sendMessage } from "@/server/mail/compose";
import {
  deleteEvent,
  discoverCalendars,
  invitationState,
  readInvitation,
  respondToEvent,
  respondToInvitation,
  listCalendars,
  listEvents,
  saveEvent,
  showCalendar,
} from "@/server/mail/calendar";
import { forgetDirectorySession, suggestRecipients } from "@/server/mail/directory";
import {
  getMessage,
  listFolders,
  listMessages,
  markMessage,
  requestAttachment,
} from "@/server/mail/messages";
import { authorizeUrl, exchangeCode, takeState } from "@/server/mail/oauth";
import { MailError } from "@/server/mail/providers/types";
import { oauthConfigured, readMailPolicy } from "@/server/mail/settings";

/**
 * Server functions of the email module. Using it needs mailbox.use and the Correo extension on (and
 * its worker connected). Every call works on the signed-in person's own accounts.
 */

const id = z.string().min(1).max(80);

type Failure = { ok: false; error: string };

function failure(error: unknown): Failure {
  if (error instanceof MailError || error instanceof VaultError)
    return { ok: false, error: error.message };
  console.error("[mail]", error);
  return { ok: false, error: "No se pudo completar." };
}

async function user(
  userId: string,
): Promise<{ sql: Sql; profile: UserProfile; ready: boolean; allowed: boolean }> {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const allowed = allows(profile, "mailbox.use");
  return { sql, profile, allowed, ready: allowed && (await extensionActive(sql, "correo")) };
}

function actorOf(profile: UserProfile): string {
  return profile.displayName || profile.loginName || "Alguien";
}

async function origin(): Promise<string> {
  const explicit = process.env.BETTER_AUTH_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const { getRequest } = await import("@tanstack/react-start/server");
  return new URL(getRequest().url).origin;
}

/** Everything the mail screen needs to start: accounts, folders and what may be configured. */
export const mailState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ready, allowed } = await user(context.userId);
    if (!allowed) return { ok: false as const, reason: "permission" as const };
    if (!ready) return { ok: false as const, reason: "off" as const };
    const policy = await readMailPolicy(sql);
    return {
      ok: true as const,
      accounts: await listAccounts(sql, context.userId),
      folders: await listFolders(sql, context.userId),
      providers: {
        imap: policy.providers.includes("imap"),
        gmail: policy.providers.includes("gmail") && oauthConfigured("gmail"),
        microsoft: policy.providers.includes("microsoft") && oauthConfigured("microsoft"),
      },
      limits: {
        maxAccounts: policy.maxAccountsPerUser,
        minInterval: policy.minIntervalSeconds,
        maxHistoryDays: policy.maxHistoryDays,
        maxAttachmentBytes: policy.maxAttachmentBytes,
      },
    };
  });

const filter = z.object({
  accountId: id.optional(),
  folderId: id.optional(),
  role: z.enum(["inbox", "sent", "drafts", "archive", "junk", "trash", "all"]).optional(),
  flagged: z.boolean().optional(),
  unread: z.boolean().optional(),
  attachments: z.boolean().optional(),
  from: z.string().max(200).optional(),
  after: z.number().int().optional(),
  before: z.number().int().optional(),
  query: z.string().max(300).optional(),
  cursor: z.string().max(300).nullable().optional(),
});

export const mailMessages = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => filter.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    return { ok: true as const, ...(await listMessages(sql, context.userId, data)) };
  });

export const mailMessage = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    const message = await getMessage(sql, context.userId, data.id);
    if (!message) return { ok: false as const, error: "Ese mensaje no existe." };
    if (!message.seen) await markMessage(sql, context.userId, data.id, { seen: true });
    return { ok: true as const, message: { ...message, seen: true as boolean } };
  });

export const mailMark = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        id,
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        hidden: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const };
    return { ok: await markMessage(sql, context.userId, data.id, data) };
  });

const imap = z.object({
  name: z.string().max(120),
  email: z.string().max(254),
  username: z.string().max(254),
  host: z.string().max(253),
  port: z.number().int(),
  smtpHost: z.string().max(253),
  smtpPort: z.number().int(),
  password: z.string().min(1).max(1000),
  historyDays: z.number().int(),
  intervalSeconds: z.number().int(),
  attachmentPolicy: z.enum(["demand", "small"]),
});

export const mailAddImap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => imap.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      const account = await createImapAccount(sql, context.userId, data);
      await recordAudit(sql, {
        actorId: context.userId,
        actorName: profile.loginName,
        action: "mail.account",
        outcome: "ok",
        area: "Correo",
        target: account.id,
        detail: "Conecta una cuenta IMAP",
      });
      return { ok: true as const, account };
    } catch (error) {
      return failure(error);
    }
  });

export const mailUpdateAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        id,
        name: z.string().max(120).optional(),
        isDefault: z.boolean().optional(),
        syncEnabled: z.boolean().optional(),
        intervalSeconds: z.number().int().optional(),
        historyDays: z.number().int().optional(),
        attachmentPolicy: z.enum(["demand", "small"]).optional(),
        mcpAccess: z.boolean().optional(),
        password: z.string().min(1).max(1000).optional(),
        smtpHost: z.string().max(253).optional(),
        smtpPort: z.number().int().optional(),
        signature: z.string().max(5000).optional(),
        webHost: z.string().max(253).optional(),
        caldavUrl: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      const { id: accountId, ...changes } = data;
      if (changes.password !== undefined || changes.webHost !== undefined)
        forgetDirectorySession(accountId);
      return {
        ok: true as const,
        account: await updateAccount(sql, context.userId, accountId, changes),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const mailAccountAction = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ id, action: z.enum(["sync", "disconnect", "delete"]) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      if (data.action === "sync") await syncNow(sql, context.userId, data.id);
      else {
        if (data.action === "disconnect") await disconnectAccount(sql, context.userId, data.id);
        else await deleteLocalData(sql, context.userId, data.id);
        await recordAudit(sql, {
          actorId: context.userId,
          actorName: profile.loginName,
          action: "mail.account",
          outcome: "ok",
          area: "Correo",
          target: data.id,
          detail:
            data.action === "disconnect"
              ? "Desconecta una cuenta"
              : "Borra la copia local de una cuenta",
        });
      }
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  });

export const mailFolderSync = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id, enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const };
    await setFolderSync(sql, context.userId, data.id, data.enabled);
    return { ok: true as const };
  });

export const mailOAuthStart = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        provider: z.enum(["gmail", "microsoft"]),
        accountId: id.nullable(),
        hint: z.string().max(254),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    const policy = await readMailPolicy(sql);
    if (!policy.providers.includes(data.provider))
      return { ok: false as const, error: "Ese proveedor no está disponible." };
    try {
      return {
        ok: true as const,
        url: await authorizeUrl(sql, {
          userId: context.userId,
          provider: data.provider,
          origin: await origin(),
          accountId: data.accountId,
          hint: data.hint,
        }),
      };
    } catch (error) {
      return failure(error);
    }
  });

/**
 * Finish an OAuth sign-in. The provider sent the person back to the Account with the code; the state
 * must be one this same signed-in person started, so a link prepared by someone else cannot
 * attach a mailbox to the wrong Grafito account.
 */
export const mailOAuthFinish = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    const started = await takeState(sql, data.state, context.userId);
    if (!started)
      return {
        ok: false as const,
        error: "La autorización caducó o no la iniciaste tú. Vuelve a intentarlo.",
      };
    try {
      const { secret, email } = await exchangeCode(sql, {
        provider: started.provider,
        code: data.code,
        verifier: started.verifier,
        origin: await origin(),
      });
      if (!email && !started.accountId)
        return { ok: false as const, error: "El proveedor no indicó la dirección de correo." };
      const account = await saveOAuthAccount(sql, context.userId, {
        provider: started.provider,
        email,
        accountId: started.accountId,
        secret,
      });
      await recordAudit(sql, {
        actorId: context.userId,
        actorName: profile.loginName,
        action: "mail.account",
        outcome: "ok",
        area: "Correo",
        target: account.id,
        detail: `Autoriza una cuenta ${started.provider}`,
      });
      return { ok: true as const, account };
    } catch (error) {
      return failure(error);
    }
  });

/** Ask for an attachment; once ready, a link valid for ten minutes to view or download it. */
export const mailAttachment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    const state = await requestAttachment(sql, context.userId, data.id);
    if (!state) return { ok: false as const, error: "Ese adjunto no existe." };
    if (state.status !== "ready")
      return { ok: true as const, status: state.status, url: null, download: null };
    const view = signToken({ a: data.id, u: context.userId, d: 0 }, 600).token;
    const download = signToken({ a: data.id, u: context.userId, d: 1 }, 600).token;
    return {
      ok: true as const,
      status: "ready",
      url: `/api/mail/attachments/${encodeURIComponent(data.id)}?t=${view}`,
      download: `/api/mail/attachments/${encodeURIComponent(data.id)}?t=${download}`,
    };
  });

/** Where a message or attachment may be archived: own portfolios and portfolio shares. */
export const mailArchiveTargets = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { portfolios: [], shares: [] };
    const portfolios = await listPortfolios(sql, context.userId);
    const shares = (await sharedWith(sql, context.userId)).filter(
      (item) => item.kind === "portfolio",
    );
    return {
      portfolios: portfolios.map((item) => ({
        id: item.id,
        name: item.name,
        parentId: item.parentId,
      })),
      shares: shares.map((item) => ({
        id: item.id,
        title: item.title,
        access: item.access,
        workspace: Boolean(item.workspace),
      })),
    };
  });

const target = z.object({
  shareId: id.nullable().optional(),
  portfolioId: id.nullable().optional(),
  newPortfolio: z.string().max(120).optional(),
});

export const mailArchive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        messageId: id,
        what: z.enum(["message", "attachments"]),
        format: z.enum(["markdown", "text", "eml"]).optional(),
        withAttachments: z.boolean().optional(),
        attachmentIds: z.array(id).max(50).optional(),
        target,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    const actor = actorOf(profile);
    try {
      if (data.what === "attachments") {
        if (!allows(profile, "files.upload"))
          return { ok: false as const, error: "Tu rol no permite subir archivos." };
        const saved = await archiveAttachments(
          sql,
          context.userId,
          actor,
          data.messageId,
          data.attachmentIds ?? [],
          data.target,
        );
        return { ok: true as const, saved: saved.length, queued: false };
      }
      const format = data.format ?? "markdown";
      if (
        format === "markdown" ? !allows(profile, "notes.create") : !allows(profile, "files.upload")
      )
        return { ok: false as const, error: "Tu rol no permite crear ese documento." };
      if (format === "eml") {
        await archiveEml(sql, context.userId, actor, data.messageId, data.target);
        return { ok: true as const, saved: 0, queued: true };
      }
      const saved = await archiveMessage(sql, context.userId, actor, data.messageId, {
        format,
        target: data.target,
        withAttachments: data.withAttachments ?? false,
      });
      return {
        ok: true as const,
        saved: 1 + saved.attachments,
        queued: false,
        documentId: saved.id,
      };
    } catch (error) {
      return failure(error);
    }
  });

// ── Writing ──────────────────────────────────────────────────────────────────────

/** Documents of the person's vault and shares that can go out as attachments. */
export const mailAttachChoices = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ query: z.string().max(200) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      return {
        ok: true as const,
        ...(await attachmentChoices(sql, context.userId, profile, data.query)),
      };
    } catch (error) {
      return failure(error);
    }
  });

const address = z.string().max(320);

export const mailSend = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        accountId: id,
        to: z.array(address).max(100),
        cc: z.array(address).max(100),
        bcc: z.array(address).max(100),
        subject: z.string().max(500),
        text: z.string().max(500_000),
        attachments: z.array(z.object({ docId: id, shareId: id.nullable() })).max(50),
        uploads: z
          .array(
            z.object({
              key: z.string().max(300),
              name: z.string().max(255),
              mime: z.string().max(120),
            }),
          )
          .max(50),
        replyTo: id.nullable(),
        quote: z
          .object({ messageId: id, kind: z.enum(["reply", "forward"]) })
          .nullable()
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      const sent = await sendMessage(sql, context.userId, profile, data);
      await recordAudit(sql, {
        actorId: context.userId,
        actorName: profile.loginName,
        action: "mail.send",
        outcome: "ok",
        area: "Correo",
        target: data.accountId,
        detail: `Envía un correo a ${sent.recipients} destinatarios${
          sent.attachments.length ? `, adjuntos de Grafito: ${sent.attachments.join(", ")}` : ""
        }${sent.uploads ? `, ${sent.uploads} archivos del equipo` : ""}`,
      });
      return { ok: true as const, sentCopy: sent.sentCopy };
    } catch (error) {
      await recordAudit(sql, {
        actorId: context.userId,
        actorName: profile.loginName,
        action: "mail.send",
        outcome: "error",
        area: "Correo",
        target: data.accountId,
        detail: error instanceof Error ? error.message : "Error",
      }).catch(() => undefined);
      return failure(error);
    }
  });

/** Files dropped from the computer that were only attached, when the message is discarded. */
export const mailDiscardUploads = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ keys: z.array(z.string().max(300)).max(50) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const };
    await discardUploads(sql, context.userId, data.keys);
    return { ok: true as const };
  });

/** People to write to: contacts seen in mail and the server's directory (Zimbra). */
export const mailRecipients = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ query: z.string().max(100) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: true as const, people: [] };
    return { ok: true as const, people: await suggestRecipients(sql, context.userId, data.query) };
  });

// ── Agenda ───────────────────────────────────────────────────────────────────────

export const mailCalendars = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    return { ok: true as const, calendars: await listCalendars(sql, context.userId) };
  });

/** Look for the calendars of an account on its server (again). */
export const mailFindCalendars = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ accountId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      return {
        ok: true as const,
        calendars: await discoverCalendars(sql, context.userId, data.accountId),
      };
    } catch (error) {
      return failure(error);
    }
  });

export const mailShowCalendar = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id, shown: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const };
    await showCalendar(sql, context.userId, data.id, data.shown);
    return { ok: true as const };
  });

export const mailEvents = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({ from: z.number().int(), to: z.number().int() })
      .refine((value) => value.to > value.from && value.to - value.from <= 62 * 86_400_000)
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      return { ok: true as const, ...(await listEvents(sql, context.userId, data.from, data.to)) };
    } catch (error) {
      return failure(error);
    }
  });

const eventInput = z.object({
  calendarId: id,
  href: z.string().max(1000).nullable(),
  etag: z.string().max(300).nullable(),
  title: z.string().max(500),
  allDay: z.boolean(),
  start: z.number().int(),
  end: z.number().int(),
  startDate: z.string().max(10),
  endDate: z.string().max(10),
  location: z.string().max(500),
  description: z.string().max(20_000),
  attendees: z.array(z.string().max(320)).max(100),
});

export const mailSaveEvent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => eventInput.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      const saved = await saveEvent(sql, context.userId, data);
      return { ok: true as const, invited: saved.invited };
    } catch (error) {
      return failure(error);
    }
  });

export const mailDeleteEvent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({ calendarId: id, href: z.string().max(1000), etag: z.string().max(300) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      await deleteEvent(sql, context.userId, data);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  });

/** Keep a message being written in the account's Drafts, attachments and all. */
export const mailSaveDraft = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        accountId: id,
        to: z.array(address).max(100),
        cc: z.array(address).max(100),
        bcc: z.array(address).max(100),
        subject: z.string().max(500),
        text: z.string().max(500_000),
        attachments: z.array(z.object({ docId: id, shareId: id.nullable() })).max(50),
        uploads: z
          .array(
            z.object({
              key: z.string().max(300),
              name: z.string().max(255),
              mime: z.string().max(120),
            }),
          )
          .max(50),
        replyTo: id.nullable(),
        quote: z
          .object({ messageId: id, kind: z.enum(["reply", "forward"]) })
          .nullable()
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready, profile } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      await sendMessage(sql, context.userId, profile, data, { draft: true });
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  });

const answer = z.enum(["ACCEPTED", "TENTATIVE", "DECLINED"]);

/** Accept, maybe or decline an event of the Agenda where the account is a guest. */
export const mailRespondEvent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({ calendarId: id, href: z.string().max(1000), etag: z.string().max(300), answer })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      await respondToEvent(sql, context.userId, data);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  });

/** The invitation (text/calendar) a message carries, once its part is downloaded. */
async function invitationOf(sql: Sql, userId: string, messageId: string) {
  const rows = await sql<{
    id: string;
    account_id: string;
    download_status: string;
    storage_key: string | null;
    email: string;
  }>`
    select t.id, t.account_id, t.download_status, t.storage_key, a.email
    from mail_attachment t join mail_account a on a.id = t.account_id
    where t.message_id = ${messageId} and t.user_id = ${userId}
      and (lower(t.content_type) like 'text/calendar%' or lower(t.filename) like '%.ics')
    order by t.created_at limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.download_status !== "ready" || !row.storage_key) {
    await requestAttachment(sql, userId, row.id);
    return { pending: true as const, accountId: row.account_id };
  }
  const bytes = await readBlob(sql, row.storage_key);
  if (!bytes) return null;
  return {
    pending: false as const,
    accountId: row.account_id,
    email: row.email,
    ics: Buffer.from(bytes).toString("utf8"),
  };
}

export const mailInvitation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ messageId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const };
    const found = await invitationOf(sql, context.userId, data.messageId);
    if (!found) return { ok: true as const, invitation: null };
    if (found.pending) return { ok: true as const, pending: true, invitation: null };
    const invitation = readInvitation(found.ics, found.email);
    if (!invitation) return { ok: true as const, invitation: null };
    const state = await invitationState(sql, context.userId, found.accountId, invitation);
    return { ok: true as const, invitation: { ...invitation, ...state } };
  });

export const mailRespondInvitation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ messageId: id, answer }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    const found = await invitationOf(sql, context.userId, data.messageId);
    if (!found || found.pending)
      return { ok: false as const, error: "La invitación todavía se está descargando." };
    try {
      const done = await respondToInvitation(sql, context.userId, {
        accountId: found.accountId,
        ics: found.ics,
        answer: data.answer,
      });
      return { ok: true as const, calendar: done.calendar };
    } catch (error) {
      return failure(error);
    }
  });
