import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { logEvent, since } from "@/server/telemetry";
import {
  ensureImportFolder,
  MAX_CONTENT,
  pullChanges,
  pushChanges,
  registerImportedDoc,
  VaultError,
} from "@/server/vault";
import { MAX_EXACT } from "@/domain/vault/anchor";
import { dropDeletedSamples, SAMPLE_DOC_IDS, SAMPLE_FOLDER_IDS } from "@/domain/vault/migrate";

/** Browser/server vault synchronization; see app/vault/sync.ts. */

const id = z.string().min(1).max(80);

const linkSchema = z.object({
  targetId: id,
  kind: z.enum(["referencia", "llama"]),
  // PDF phrase link; see domain/vault/anchor.ts.
  anchor: z
    .object({
      page: z.number().int().min(1).max(100_000),
      exact: z.string().min(1).max(MAX_EXACT),
      prefix: z.string().max(64),
      suffix: z.string().max(64),
    })
    .optional(),
  // Portfolio and shared targets; see ManualLink.
  target: z.literal("portfolio").optional(),
  shareId: id.optional(),
});

const docSchema = z.object({
  id,
  title: z.string().max(200),
  kind: z.enum(["markdown", "file"]),
  portfolioId: id.nullable(),
  content: z.string().max(MAX_CONTENT),
  // New files supply keys; legacy/sample dataUrl content is migrated by server/files.ts.
  file: z
    .object({
      name: z.string().max(200),
      mime: z.string().max(120),
      key: z.string().max(200).optional(),
      size: z.number().int().min(0).optional(),
      dataUrl: z.string().max(1_500_000).optional(),
    })
    .nullable(),
  links: z.array(linkSchema).max(500),
  pinned: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  createdBy: z.string().max(80),
  updatedBy: z.string().max(80),
  // Server base for this note edit; see SyncBase.
  base: z
    .object({
      content: z.string().max(MAX_CONTENT),
      title: z.string().max(200),
      updatedAt: z.number(),
    })
    .optional(),
});

const portfolioSchema = z.object({
  id,
  name: z.string().max(120),
  parentId: id.nullable(),
  links: z.array(linkSchema).max(500).optional(),
});

/** Without write capabilities, browser changes cannot mutate the server vault. */
const WRITE = [
  PERMISSION.notesCreate,
  PERMISSION.notesEdit,
  PERMISSION.notesDelete,
  PERMISSION.filesUpload,
  PERMISSION.filesDelete,
  PERMISSION.portfoliosManage,
  PERMISSION.linksManage,
];

export const pushVault = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        docs: z.array(docSchema).max(500),
        deletedDocs: z.array(id).max(2000),
        portfolios: z.array(portfolioSchema).max(2000),
        deletedPortfolios: z.array(id).max(2000),
        /** Sent once after «Restaurar el ejemplo»: the sample may come back. */
        restoreSamples: z.boolean().optional(),
        /** How long the oldest deletion sent waited in the browser, for the trash delay. */
        deleteAgeMs: z.number().int().min(0).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const started = performance.now();
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!WRITE.some((key) => allows(profile, key)))
      return { ok: false as const, error: "Tu rol no puede modificar la bóveda." };
    const canDelete =
      allows(profile, PERMISSION.notesDelete) || allows(profile, PERMISSION.filesDelete);
    if (data.deletedDocs.length > 0 && !canDelete)
      return { ok: false as const, error: "Tu rol no puede borrar." };
    if (data.deletedPortfolios.length > 0 && !allows(profile, PERMISSION.portfoliosManage)) {
      return { ok: false as const, error: "Tu rol no puede borrar portafolios." };
    }
    // What is in the trash (or was purged) is not brought back by a browser that still holds an
    // older copy of it: a copy saved before the deletion, read again after a reload, looked like
    // new work. A document edited after it was deleted still comes back (the newest change
    // wins), and so does the sample documentation when the person asked to restore it.
    const deleted = await sql<{ id: string; kind: string; deleted_at: unknown }>`
      select id, 'doc' as kind, deleted_at from vault_doc
      where user_id = ${context.userId} and deleted
        and id = any(string_to_array(${data.docs.map((doc) => doc.id).join(",")}, ','))
      union all
      select id, 'portfolio' as kind, deleted_at from vault_portfolio
      where user_id = ${context.userId} and deleted
        and id = any(string_to_array(${data.portfolios.map((portfolio) => portfolio.id).join(",")}, ','))
    `;
    const restoring = (id: string, samples: readonly string[]) =>
      data.restoreSamples === true && samples.includes(id);
    const deletedAt = new Map(deleted.map((row) => [`${row.kind}:${row.id}`, row.deleted_at]));
    const goneDocs = new Set(
      data.docs
        .filter((doc) => {
          if (!deletedAt.has(`doc:${doc.id}`)) return false;
          if (restoring(doc.id, SAMPLE_DOC_IDS)) return false;
          if (SAMPLE_DOC_IDS.includes(doc.id)) return true;
          const at = deletedAt.get(`doc:${doc.id}`);
          return at === null || at === undefined || doc.updatedAt <= Number(at);
        })
        .map((doc) => doc.id),
    );
    const goneFolders = new Set(
      data.portfolios
        .filter(
          (portfolio) =>
            deletedAt.has(`portfolio:${portfolio.id}`) &&
            !restoring(portfolio.id, SAMPLE_FOLDER_IDS),
        )
        .map((portfolio) => portfolio.id),
    );
    const kept = dropDeletedSamples(data, { docs: goneDocs, portfolios: goneFolders });
    if (goneDocs.size + goneFolders.size > 0)
      logEvent("sync.revive.refused", { docs: goneDocs.size, portfolios: goneFolders.size });
    const result = await pushChanges(sql, context.userId, kept);
    logEvent("sync.push", {
      docs: kept.docs.length,
      deletedDocs: kept.deletedDocs.length,
      portfolios: kept.portfolios.length,
      deletedPortfolios: kept.deletedPortfolios.length,
      conflicts: result.conflicts.length,
      deleteAgeMs: data.deleteAgeMs,
      ms: since(started),
    });
    // The browser drops what was refused, so it stops showing it (in the graph too).
    const dropped = {
      docs: data.docs.filter((doc) => !kept.docs.includes(doc)).map((doc) => doc.id),
      portfolios: data.portfolios
        .filter((portfolio) => !kept.portfolios.includes(portfolio))
        .map((portfolio) => portfolio.id),
    };
    return { ok: true as const, ...result, dropped };
  });

/** Import correlation id, so the server's events of one upload job can be followed. */
const importId = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .optional();

/**
 * A folder of a background upload, on the server before anything goes into it: an existing one
 * with the same name in the same place, or a new one with the browser's id.
 */
export const importFolder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({ id, name: z.string().min(1).max(120), parentId: id.nullable(), importId })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const started = performance.now();
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.portfoliosManage))
      return { ok: false as const, error: "No puedes crear portafolios aquí." };
    try {
      const result = await ensureImportFolder(sql, context.userId, data);
      logEvent("import.folder", {
        importId: data.importId,
        created: result.created,
        ms: since(started),
      });
      return { ok: true as const, ...result };
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      logEvent("import.folder.failed", { importId: data.importId, status: error.status });
      return { ok: false as const, error: error.message };
    }
  });

/** A Markdown file of a background upload, stored as a note under the browser's id. */
export const importNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        doc: docSchema.omit({ base: true, file: true }).extend({ kind: z.literal("markdown") }),
        importId,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const started = performance.now();
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, PERMISSION.notesCreate))
      return { ok: false as const, error: "Tu rol no permite crear notas." };
    try {
      const result = await registerImportedDoc(sql, context.userId, { ...data.doc, file: null });
      logEvent("import.note", {
        importId: data.importId,
        created: result.created,
        chars: data.doc.content.length,
        ms: since(started),
      });
      return { ok: true as const, ...result };
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      logEvent("import.note.failed", { importId: data.importId, status: error.status });
      return { ok: false as const, error: error.message };
    }
  });

/** What the browser measured during one upload job, logged as one line on the server. */
export const reportImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z
      .object({
        importId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        status: z.enum(["done", "cancelled"]),
        ms: z.number().int().min(0),
        folders: z.number().int().min(0),
        files: z.number().int().min(0),
        done: z.number().int().min(0),
        existing: z.number().int().min(0),
        failed: z.number().int().min(0),
        skipped: z.number().int().min(0),
        bytes: z.number().int().min(0),
        syncMs: z.number().int().min(0),
        syncs: z.number().int().min(0),
        /** Failures per stage: transfer, register, folder, read. */
        errors: z.record(z.string().max(20), z.number().int().min(0)),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireLease(context.userId);
    logEvent("import.summary", { ...data, errors: JSON.stringify(data.errors) });
    return { ok: true as const };
  });

export const pullVault = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ since: z.number().int().min(0) }).parse(input))
  .handler(async ({ context, data }) => {
    const started = performance.now();
    const sql = await requireLease(context.userId);
    const pulled = await pullChanges(sql, context.userId, data.since);
    const items =
      pulled.docs.length +
      pulled.deletedDocs.length +
      pulled.portfolios.length +
      pulled.deletedPortfolios.length;
    const ms = since(started);
    if (items > 0 || ms > 500) logEvent("sync.pull", { full: data.since === 0, items, ms });
    return pulled;
  });
