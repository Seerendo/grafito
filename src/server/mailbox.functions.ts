import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { MAIL_PROVIDERS, parseMailPolicy } from "@/domain/mail/policy";
import type { Sql } from "@/lib/db";
import { logActivity, recordAudit } from "@/server/audit";
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
import { mailStats, pauseAccount, retryFailed } from "@/server/mail/admin";
import { archiveAttachments, archiveEml, archiveMessage } from "@/server/mail/archive";
import {
  getMessage,
  listFolders,
  listMessages,
  markMessage,
  requestAttachment,
} from "@/server/mail/messages";
import { authorizeUrl, exchangeCode, takeState } from "@/server/mail/oauth";
import { MailError } from "@/server/mail/providers/types";
import {
  deleteProfile,
  listProfiles,
  oauthConfigured,
  readMailPolicy,
  saveProfile,
  writeMailPolicy,
  writeOAuthApp,
} from "@/server/mail/settings";

/**
 * Server functions of the email module. Using it needs mailbox.use and the Correo extension on (and
 * its worker connected); administering it needs mailbox.manage, which shows figures and settings but
 * never anyone's messages. Every call works on the signed-in person's own accounts.
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

/** Whether to show the mail entry in the menu: the role has it and the extension is on. */
export const mailAvailable = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { ready } = await user(context.userId);
    return { ready };
  });

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
      profiles: (await listProfiles(sql)).map((item) => ({
        id: item.id,
        name: item.name,
        domains: item.domains,
      })),
      providers: {
        imap: policy.providers.includes("imap"),
        gmail: policy.providers.includes("gmail") && (await oauthConfigured(sql, "gmail")),
        microsoft:
          policy.providers.includes("microsoft") && (await oauthConfigured(sql, "microsoft")),
      },
      limits: {
        profilesOnly: policy.profilesOnly,
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
  password: z.string().min(1).max(1000),
  profileId: id.nullable(),
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
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, ready } = await user(context.userId);
    if (!ready) return { ok: false as const, error: "El correo no está disponible." };
    try {
      const { id: accountId, ...changes } = data;
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
      return { ok: false as const, error: "El administrador no permite ese proveedor." };
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
 * Finish an OAuth sign-in. The provider sent the person back to /correo with the code; the state
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

// ── Administration (mailbox.manage) ───────────────────────────────────────────────

async function manager(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, profile, allowed: allows(profile, "mailbox.manage") };
}

export const mailAdminState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const };
    return {
      ok: true as const,
      policy: await readMailPolicy(sql),
      profiles: await listProfiles(sql),
      oauth: {
        gmail: await oauthApp(sql, "gmail"),
        microsoft: await oauthApp(sql, "microsoft"),
      },
      redirectUri: `${await origin()}/api/mail/oauth/callback`,
      stats: await mailStats(sql),
    };
  });

async function oauthApp(sql: Sql, provider: "gmail" | "microsoft") {
  const rows = await sql<{
    value: string;
  }>`select value from app_setting where key = ${`mail_oauth_${provider}`} limit 1`;
  if (!rows[0]) return { clientId: "", tenant: "common", hasSecret: false };
  const value = JSON.parse(rows[0].value) as {
    clientId?: string;
    tenant?: string;
    secret?: string;
  };
  return {
    clientId: value.clientId ?? "",
    tenant: value.tenant ?? "common",
    hasSecret: Boolean(value.secret),
  };
}

export const mailAdminSave = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        policy: z.record(z.string(), z.unknown()).optional(),
        oauth: z
          .object({
            provider: z.enum(["gmail", "microsoft"]),
            clientId: z.string().max(300),
            clientSecret: z.string().max(1000),
            tenant: z.string().max(100),
          })
          .optional(),
        profile: z
          .object({
            id: id.optional(),
            name: z.string().min(1).max(120),
            host: z.string().min(1).max(253),
            port: z.number().int(),
            domains: z.array(z.string().max(253)).max(50),
          })
          .optional(),
        deleteProfile: id.optional(),
        pauseAccount: z.object({ id, paused: z.boolean() }).optional(),
        retryFailed: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, profile, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const, error: "Sin permiso." };
    const actor = {
      actorId: context.userId,
      actorName: profile.loginName || profile.displayName,
      area: "Correo",
    };
    if (data.policy) {
      const before = await readMailPolicy(sql);
      const next = await writeMailPolicy(sql, parseMailPolicy({ ...before, ...data.policy }));
      await logActivity(sql, {
        ...actor,
        message:
          next.paused !== before.paused
            ? next.paused
              ? "Pausa la sincronización de correo"
              : "Reanuda la sincronización de correo"
            : "Cambia la política del correo",
      });
    }
    if (data.oauth) {
      await writeOAuthApp(sql, data.oauth.provider, data.oauth);
      await logActivity(sql, {
        ...actor,
        message: `Configura la conexión OAuth de ${data.oauth.provider}`,
      });
    }
    if (data.profile) {
      if (![993, 143].includes(data.profile.port))
        return { ok: false as const, error: "El puerto tiene que ser 993 o 143." };
      await saveProfile(sql, {
        id: data.profile.id ?? crypto.randomUUID(),
        name: data.profile.name.trim(),
        provider: "imap",
        host: data.profile.host,
        port: data.profile.port,
        tls: true,
        domains: data.profile.domains.map((item) => item.trim().toLowerCase()).filter(Boolean),
      });
      await logActivity(sql, {
        ...actor,
        message: `Guarda el perfil de correo ${data.profile.name.trim()}`,
      });
    }
    if (data.deleteProfile) {
      await deleteProfile(sql, data.deleteProfile);
      await logActivity(sql, { ...actor, message: "Borra un perfil de correo" });
    }
    if (data.pauseAccount) {
      await pauseAccount(sql, data.pauseAccount.id, data.pauseAccount.paused);
      await logActivity(sql, {
        ...actor,
        message: `${data.pauseAccount.paused ? "Pausa" : "Reanuda"} una cuenta de correo (${data.pauseAccount.id})`,
      });
    }
    if (data.retryFailed) {
      const count = await retryFailed(sql);
      await logActivity(sql, { ...actor, message: `Reintenta ${count} trabajos de correo` });
    }
    return { ok: true as const };
  });

export const MAIL_PROVIDER_IDS = MAIL_PROVIDERS;
