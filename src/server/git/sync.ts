import { claimJob } from "@/server/jobs";
import { randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import { merge3 } from "@/domain/vault/merge";
import type { Document } from "@/domain/vault/types";
import { decrypt, encrypt } from "../crypto";
import { maxUploadBytes, putBlob, readBlob } from "../blobs";
import { decodeDataUrl, newFileKey } from "../files";
import {
  createNote,
  createPortfolio,
  deleteDoc,
  getDoc,
  MAX_CONTENT,
  pushChanges,
  replaceFile,
  updateNote,
} from "../vault";
import { safeName, uniqueName } from "../zip";
import {
  GitError,
  gitBlobSha,
  openRepo,
  type Change,
  type GitRepo,
  type Provider,
  type RemoteFile,
} from "./providers";

/**
 * Bidirectional portfolio/vault synchronization with a repository folder. Compare against
 * git_link_file: push local-only changes, pull remote-only changes with history, merge
 * concurrent note edits or preserve conflicting remote content as a Git copy. Propagate
 * deletions unless the other side changed. push/pull limit direction. Ignore dot-prefixed
 * paths.
 */

export const ALL = "all";
const ACTOR = "Git";
/** Stay below GitHub's 100 MB blob limit. */
const MAX_PUSH_BYTES = 90 * 1024 * 1024;

export type Direction = "both" | "push" | "pull";

export type LinkRow = {
  id: string;
  user_id: string;
  portfolio_id: string;
  provider: Provider;
  base_url: string;
  repo: string;
  branch: string;
  folder: string;
  direction: Direction;
  token: string;
  hook_secret: string;
  head: string | null;
  pending: unknown;
  last_error: string;
  last_sync_at: unknown;
  last_summary: string;
};

type FileRow = {
  path: string;
  doc_id: string;
  blob_sha: string;
  doc_updated_at: unknown;
  doc_title: string;
  doc_portfolio: string | null;
  base: string | null;
};

type LocalDoc = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolio_id: string | null;
  content: string;
  file_name: string | null;
  file_mime: string | null;
  file_key: string | null;
  file_data: string | null;
  updated_at: unknown;
};

export type SyncSummary = {
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: number;
  skipped: string[];
};

export function newHookSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function sealToken(token: string): string {
  return encrypt(token);
}

/** Normalize repository folder slashes. */
export function cleanFolder(folder: string): string {
  return folder
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  excalidraw: "application/vnd.excalidraw+json",
  zip: "application/zip",
};

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

const isNotePath = (path: string) => /\.(md|markdown)$/i.test(path);
const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Add a Git suffix before the extension for conflicting repository copies. */
function conflictName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (Git)${name.slice(dot)}` : `${name} (Git)`;
}

export async function readLink(sql: Sql, id: string): Promise<LinkRow | null> {
  const rows = await sql<LinkRow>`select * from git_link where id = ${id} limit 1`;
  return rows[0] ?? null;
}

export function repoFor(
  link: Pick<LinkRow, "provider" | "base_url" | "repo" | "branch" | "token">,
): GitRepo {
  return openRepo({
    provider: link.provider,
    baseUrl: link.base_url,
    repo: link.repo,
    branch: link.branch,
    token: decrypt(link.token),
  });
}

/** Synchronize one link completely; throw GitError on failure. */
export async function syncLink(sql: Sql, link: LinkRow): Promise<SyncSummary> {
  const repo = repoFor(link);
  const userId = link.user_id;
  const whole = link.portfolio_id === ALL;
  const prefix = link.folder ? `${link.folder}/` : "";
  const summary: SyncSummary = { pulled: 0, pushed: 0, deleted: 0, conflicts: 0, skipped: [] };
  const canPush = link.direction !== "pull";
  const canPull = link.direction !== "push";

  // Map portfolios to repository folders.
  const portfolios = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from vault_portfolio where user_id = ${userId} and not deleted
  `;
  const byId = new Map(portfolios.map((row) => [row.id, row]));
  if (!whole && !byId.has(link.portfolio_id))
    throw new GitError("El portafolio enlazado ya no existe.");
  const rootId = whole ? null : link.portfolio_id;
  const folders = new Map<string | null, string>([[rootId, ""]]);
  const childNames = new Map<string, Set<string>>();
  const taken = (folder: string) => {
    let set = childNames.get(folder);
    if (!set) childNames.set(folder, (set = new Set()));
    return set;
  };
  const folderOf = (id: string | null, seen = new Set<string>()): string | null => {
    if (folders.has(id)) return folders.get(id)!;
    if (id === null) return null;
    const row = byId.get(id);
    if (!row || seen.has(id)) return null;
    seen.add(id);
    const parent = folderOf(row.parent_id, seen);
    if (parent === null) return null;
    const folder = `${parent}${uniqueName(safeName(row.name, "Portafolio"), taken(parent))}/`;
    folders.set(id, folder);
    return folder;
  };
  for (const row of [...portfolios].sort((a, b) => a.name.localeCompare(b.name))) folderOf(row.id);

  // Grafito documents within the linked portfolio.
  const docs = (
    await sql<LocalDoc>`
      select id, title, kind, portfolio_id, content, file_name, file_mime, file_key, file_data, updated_at
      from vault_doc where user_id = ${userId} and not deleted order by created_at
    `
  ).filter(
    (doc) => folderOf(doc.portfolio_id) !== null && (doc.kind === "markdown" || doc.file_name),
  );

  const rows = await sql<FileRow>`select * from git_link_file where link_id = ${link.id}`;
  const rowByDoc = new Map(rows.map((row) => [row.doc_id, row]));
  const rowByPath = new Map(rows.map((row) => [row.path, row]));

  // Reuse prior document paths when title and portfolio are unchanged.
  const pathOf = new Map<string, string>();
  const used = new Set<string>();
  for (const doc of docs) {
    const row = rowByDoc.get(doc.id);
    if (
      row &&
      row.doc_title === doc.title &&
      row.doc_portfolio === doc.portfolio_id &&
      !used.has(row.path.toLowerCase())
    ) {
      pathOf.set(doc.id, row.path);
      used.add(row.path.toLowerCase());
      taken(dirName(row.path) ? `${dirName(row.path)}/` : "").add(baseName(row.path).toLowerCase());
    }
  }
  for (const doc of docs) {
    if (pathOf.has(doc.id)) continue;
    const folder = folderOf(doc.portfolio_id)!;
    const name =
      doc.kind === "markdown"
        ? `${safeName(doc.title, "Nota")}.md`
        : safeName(doc.file_name!, "archivo");
    const path = folder + uniqueName(name, taken(folder));
    pathOf.set(doc.id, path);
    used.add(path.toLowerCase());
  }

  const localChanged = docs.some((doc) => {
    const row = rowByDoc.get(doc.id);
    return (
      !row ||
      Number(row.doc_updated_at) !== Number(doc.updated_at) ||
      row.path !== pathOf.get(doc.id)
    );
  });
  const docIds = new Set(docs.map((doc) => doc.id));
  const localGone = rows.some((row) => !docIds.has(row.doc_id));

  const head = await repo.head();
  // No changes on either side require only one API call.
  if (head && head === link.head && !localChanged && !localGone) return summary;

  const remote = new Map<string, string>();
  if (head) {
    const files: RemoteFile[] = await repo.tree(head);
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const rel = file.path.slice(prefix.length);
      if (!rel || hidden(rel)) continue;
      remote.set(rel, file.sha);
    }
  }

  // Do not empty Grafito when a branch or folder disappears; this is usually a configuration error.
  if (rows.length > 0 && !head)
    throw new GitError(
      `La rama ${link.branch} ya no existe en el repositorio. No se borró nada en Grafito.`,
    );
  if (rows.length > 0 && remote.size === 0) {
    throw new GitError(
      `La carpeta ${link.folder || "raíz"} está vacía o no existe en el repositorio. No se borró nada en Grafito.`,
    );
  }

  const changes = new Map<string, Change>();
  /** Rows persisted only after a successful commit; other rows save immediately. */
  const afterCommit: FileRow[] = [];
  const dropRow = async (path: string) => {
    await sql`delete from git_link_file where link_id = ${link.id} and path = ${path}`;
  };
  const saveRow = async (row: FileRow) => {
    await sql`
      insert into git_link_file (link_id, path, doc_id, blob_sha, doc_updated_at, doc_title, doc_portfolio, base)
      values (${link.id}, ${row.path}, ${row.doc_id}, ${row.blob_sha}, ${Number(row.doc_updated_at)}, ${row.doc_title},
        ${row.doc_portfolio}, ${row.base})
      on conflict (link_id, path) do update set doc_id = excluded.doc_id, blob_sha = excluded.blob_sha,
        doc_updated_at = excluded.doc_updated_at, doc_title = excluded.doc_title, doc_portfolio = excluded.doc_portfolio,
        base = excluded.base
    `;
  };
  const rowFor = (doc: Document, path: string, sha: string): FileRow => ({
    path,
    doc_id: doc.id,
    blob_sha: sha,
    doc_updated_at: doc.updatedAt,
    doc_title: doc.title,
    doc_portfolio: doc.portfolioId,
    base: doc.kind === "markdown" ? doc.content : null,
  });

  const bytesOf = async (doc: LocalDoc): Promise<Uint8Array | null> => {
    if (doc.kind === "markdown") return new TextEncoder().encode(doc.content);
    if (doc.file_key) return readBlob(sql, doc.file_key);
    const decoded = doc.file_data ? decodeDataUrl(doc.file_data) : null;
    return decoded ? new Uint8Array(decoded.bytes) : null;
  };
  const push = (path: string, bytes: Uint8Array, docId: string, row: () => FileRow) => {
    if (bytes.length > MAX_PUSH_BYTES) {
      summary.skipped.push(path);
      return;
    }
    changes.set(path, { path, bytes, exists: remote.has(path) });
    afterCommit.push({ ...row(), path, doc_id: docId, blob_sha: gitBlobSha(bytes) });
  };
  const removeRemote = (path: string) => {
    if (remote.has(path) && !changes.has(path))
      changes.set(path, { path, bytes: null, exists: true });
  };

  // Resolve or create the portfolio corresponding to a repository folder.
  const portfolioFor = async (folder: string): Promise<string | null> => {
    let parent = rootId;
    let path = "";
    for (const part of folder.split("/").filter(Boolean)) {
      path += `${part}/`;
      const known = [...folders.entries()].find(
        ([id, value]) => value === path && id !== undefined,
      );
      if (known) {
        parent = known[0];
        continue;
      }
      const created = await createPortfolio(sql, userId, { name: part, parentId: parent }).catch(
        async () => {
          // Reuse an existing case-insensitive name match.
          const same = await sql<{ id: string }>`
          select id from vault_portfolio where user_id = ${userId} and not deleted and lower(name) = lower(${part})
            and coalesce(parent_id, '') = coalesce(${parent}, '') limit 1
        `;
          return same[0] ? { id: same[0].id } : null;
        },
      );
      if (!created) return parent;
      folders.set(created.id, path);
      parent = created.id;
    }
    return parent;
  };

  const importRemote = async (
    path: string,
    sha: string,
    name = baseName(path),
  ): Promise<Document | null> => {
    const bytes = await repo.readBlob(sha);
    const portfolioId = await portfolioFor(dirName(path));
    if (isNotePath(name)) {
      const content = new TextDecoder().decode(bytes);
      if (content.length > MAX_CONTENT) {
        summary.skipped.push(path);
        return null;
      }
      return createNote(sql, userId, {
        title: name.replace(/\.(md|markdown)$/i, ""),
        content,
        portfolioId,
        actor: ACTOR,
      });
    }
    if (bytes.length > maxUploadBytes()) {
      summary.skipped.push(path);
      return null;
    }
    const key = newFileKey(userId);
    const mime = mimeOf(name);
    await putBlob(sql, key, bytes, mime);
    const now = Date.now();
    const doc: Document = {
      id: crypto.randomUUID(),
      title: name.replace(/\.[^.]+$/, "") || name,
      kind: "file",
      portfolioId,
      content: "",
      file: { name, mime, key, size: bytes.length },
      links: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      createdBy: ACTOR,
      updatedBy: ACTOR,
    };
    await pushChanges(sql, userId, {
      docs: [doc],
      deletedDocs: [],
      portfolios: [],
      deletedPortfolios: [],
    });
    return getDoc(sql, userId, doc.id);
  };

  /** Apply repository content to the document. */
  const applyRemote = async (doc: LocalDoc, bytes: Uint8Array): Promise<Document | null> => {
    if (doc.kind === "markdown") {
      const content = new TextDecoder().decode(bytes);
      if (content.length > MAX_CONTENT) return null;
      return updateNote(sql, userId, doc.id, { content, actor: ACTOR, separateVersion: true });
    }
    if (bytes.length > maxUploadBytes()) return null;
    const key = newFileKey(userId);
    await putBlob(sql, key, bytes, doc.file_mime ?? mimeOf(doc.file_name ?? ""));
    if (doc.file_key)
      return replaceFile(sql, userId, doc.id, {
        key,
        size: bytes.length,
        actor: ACTOR,
        separateVersion: true,
      });
    return null;
  };

  const claimed = new Set<string>();

  // Grafito documents.
  for (const doc of docs) {
    const path = pathOf.get(doc.id)!;
    claimed.add(path);
    const row = rowByDoc.get(doc.id);
    const changedHere =
      !row || Number(row.doc_updated_at) !== Number(doc.updated_at) || row.path !== path;
    if (!row) {
      if (!canPush) continue;
      const bytes = await bytesOf(doc);
      if (!bytes) continue;
      const there = remote.get(path);
      if (there && there === gitBlobSha(bytes)) {
        // Identical repository content only needs linking.
        await saveRow({
          path,
          doc_id: doc.id,
          blob_sha: there,
          doc_updated_at: doc.updated_at,
          doc_title: doc.title,
          doc_portfolio: doc.portfolio_id,
          base: doc.kind === "markdown" ? doc.content : null,
        });
        continue;
      }
      if (there && !rowByPath.has(path)) {
        // Avoid overwriting an unrelated same-name repository file; choose another path.
        const dir = dirName(path);
        const inFolder = [...remote.keys(), ...used].filter(
          (item) => dirName(item.toLowerCase()) === dir.toLowerCase(),
        );
        const other =
          (dir ? `${dir}/` : "") +
          uniqueName(baseName(path), new Set(inFolder.map((item) => baseName(item).toLowerCase())));
        claimed.add(other);
        push(other, bytes, doc.id, () => localRow(doc, other));
        continue;
      }
      push(path, bytes, doc.id, () => localRow(doc, path));
      continue;
    }
    claimed.add(row.path);
    const thereNow = remote.get(row.path);
    const changedThere = thereNow !== row.blob_sha;
    if (!changedThere && !changedHere) continue;

    if (changedThere && thereNow === undefined) {
      // Deleted in the repository.
      if (canPull && !changedHere) {
        await deleteDoc(sql, userId, doc.id).catch(() => undefined);
        await dropRow(row.path);
        summary.deleted += 1;
        continue;
      }
      if (!canPush) continue;
      const bytes = await bytesOf(doc);
      if (bytes) push(path, bytes, doc.id, () => localRow(doc, path));
      continue;
    }

    if (changedThere && canPull) {
      const remoteBytes = await repo.readBlob(thereNow!);
      if (!changedHere || !canPush) {
        const updated = await applyRemote(doc, remoteBytes);
        if (updated) {
          await saveRow(rowFor(updated, row.path, thereNow!));
          summary.pulled += 1;
        } else summary.skipped.push(row.path);
        continue;
      }
      // Both sides changed.
      if (doc.kind === "markdown") {
        const result = merge3(row.base ?? "", doc.content, new TextDecoder().decode(remoteBytes));
        if (result.ok) {
          const merged = await updateNote(sql, userId, doc.id, {
            content: result.text,
            actor: ACTOR,
            separateVersion: true,
          });
          // The note already contains repository changes; keep the merged result pending until the commit succeeds.
          await saveRow({ ...rowFor(merged, row.path, thereNow!), doc_updated_at: doc.updated_at });
          if (path !== row.path) removeRemote(row.path);
          push(path, new TextEncoder().encode(merged.content), doc.id, () =>
            rowFor(merged, path, ""),
          );
          summary.pulled += 1;
          continue;
        }
      }
      // Preserve conflicting repository content as a copy and push Grafito's version.
      const copy = await importRemote(row.path, thereNow!, conflictName(baseName(row.path)));
      if (copy) summary.conflicts += 1;
      // Remember the created conflict copy so failed commits do not duplicate it.
      await saveRow({ ...row, blob_sha: thereNow! });
      const bytes = await bytesOf(doc);
      if (path !== row.path) removeRemote(row.path);
      if (bytes) push(path, bytes, doc.id, () => localRow(doc, path));
      continue;
    }

    // Only Grafito changed, or pulling is disabled.
    if (!canPush || !changedHere) continue;
    const bytes = await bytesOf(doc);
    if (!bytes) continue;
    if (path !== row.path) removeRemote(row.path);
    push(path, bytes, doc.id, () => localRow(doc, path));
  }

  // Documents deleted from or moved outside Grafito's linked portfolio.
  for (const row of rows) {
    if (docIds.has(row.doc_id)) continue;
    const thereNow = remote.get(row.path);
    if (thereNow === undefined) {
      await dropRow(row.path);
      continue;
    }
    claimed.add(row.path);
    if (thereNow !== row.blob_sha && canPull) {
      // Restore remotely changed content rather than deleting it.
      const restored = await importRemote(row.path, thereNow);
      await dropRow(row.path);
      if (restored) {
        await saveRow(rowFor(restored, row.path, thereNow));
        summary.pulled += 1;
      }
      continue;
    }
    // In push mode, remove the tracking row only after commit success so failures retry.
    if (canPush) {
      removeRemote(row.path);
      summary.deleted += 1;
    } else await dropRow(row.path);
  }

  // New repository content.
  if (canPull) {
    for (const [path, sha] of remote) {
      if (claimed.has(path) || rowByPath.has(path) || changes.has(path)) continue;
      const created = await importRemote(path, sha);
      if (created) {
        await saveRow(rowFor(created, path, sha));
        summary.pulled += 1;
      } else if (!summary.skipped.includes(path)) summary.skipped.push(path);
    }
  }

  // One commit contains all Grafito changes.
  const list = [...changes.values()].filter((change) => change.bytes || change.exists);
  let nextHead = head;
  if (list.length > 0) {
    const pushed = list.filter((change) => change.bytes).length;
    const removed = list.length - pushed;
    const message = [`Grafito: ${pushed} actualizado(s)`, removed ? `${removed} borrado(s)` : ""]
      .filter(Boolean)
      .join(", ");
    nextHead = await repo.commit(
      head,
      message,
      list.map((change) => ({ ...change, path: prefix + change.path })),
    );
    for (const row of afterCommit) {
      const old = rowByDoc.get(row.doc_id);
      if (old && old.path !== row.path) await dropRow(old.path);
      await saveRow(row);
    }
    for (const change of list) if (!change.bytes) await dropRow(change.path);
    summary.pushed += pushed;
  }
  await sql`update git_link set head = ${nextHead} where id = ${link.id}`;
  return summary;

  function localRow(doc: LocalDoc, path: string): FileRow {
    return {
      path,
      doc_id: doc.id,
      blob_sha: "",
      doc_updated_at: doc.updated_at,
      doc_title: doc.title,
      doc_portfolio: doc.portfolio_id,
      base: doc.kind === "markdown" ? doc.content : null,
    };
  }
}

// Automatic synchronization passes.

const RUNNING = new Set<string>();

/** Sync interval in minutes from GRAFITO_GIT_SYNC_MINUTES, default two. */
export function syncMinutes(): number {
  const value = Number(process.env.GRAFITO_GIT_SYNC_MINUTES);
  return Number.isFinite(value) && value >= 1 ? value : 2;
}

export function describe(summary: SyncSummary): string {
  const parts = [
    summary.pulled ? `${summary.pulled} traído(s)` : "",
    summary.pushed ? `${summary.pushed} subido(s)` : "",
    summary.deleted ? `${summary.deleted} borrado(s)` : "",
    summary.conflicts ? `${summary.conflicts} conflicto(s) guardado(s) como copia «(Git)»` : "",
    summary.skipped.length ? `${summary.skipped.length} omitido(s) por tamaño` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Sin cambios";
}

/** Synchronize and persist the outcome without throwing. */
export async function runLink(sql: Sql, id: string): Promise<{ ok: boolean; message: string }> {
  if (RUNNING.has(id)) return { ok: true, message: "Ya se está sincronizando." };
  RUNNING.add(id);
  const now = Date.now();
  try {
    const link = await readLink(sql, id);
    if (!link) return { ok: false, message: "Ese enlace ya no existe." };
    const summary = await syncLink(sql, link);
    const text = describe(summary);
    // No-change passes preserve the latest meaningful summary.
    await sql`
      update git_link set pending = false, last_error = '', last_sync_at = ${now},
        last_summary = ${text === "Sin cambios" && link.last_summary ? link.last_summary : text}
      where id = ${id}
    `;
    return { ok: true, message: text };
  } catch (error) {
    const message = error instanceof GitError ? error.message : "Falló la sincronización.";
    if (!(error instanceof GitError)) console.error("[git]", error);
    const retry = error instanceof GitError && error.retry;
    await sql`
      update git_link set pending = ${retry}, last_error = ${retry ? "" : message}, last_sync_at = ${now} where id = ${id}
    `.catch(() => undefined);
    return { ok: retry, message };
  } finally {
    RUNNING.delete(id);
  }
}

/** Whether the administrator enabled the git plugin. */
export async function gitEnabled(sql: Sql): Promise<boolean> {
  const rows = await sql<{
    enabled: unknown;
  }>`select enabled from app_plugin where id = 'git' limit 1`;
  const value = rows[0]?.enabled;
  return value === true || value === "t" || value === "true" || value === 1;
}

/** Links due because they are pending or older than syncMinutes. */
export async function syncDue(sql: Sql): Promise<void> {
  if (!(await gitEnabled(sql))) return;
  const before = Date.now() - syncMinutes() * 60_000;
  const due = await sql<{ id: string }>`
    select id from git_link where pending or last_sync_at is null or last_sync_at < ${before} order by last_sync_at nulls first
  `;
  for (const row of due) await runLink(sql, row.id);
}

const TICK_MS = 30_000;
const globalRef = globalThis as typeof globalThis & {
  __grafitoGitSync__?: ReturnType<typeof setInterval>;
};

/** Start automatic sync once per process. */
export function startGitSync(): void {
  if (globalRef.__grafitoGitSync__) return;
  globalRef.__grafitoGitSync__ = setInterval(() => {
    void (async () => {
      try {
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        // Only one replica performs each scheduled pass.
        if (!(await claimJob(sql, "git-sync", TICK_MS - 1000))) return;
        await syncDue(sql);
      } catch (error) {
        console.error("[git]", error);
      }
    })();
  }, TICK_MS);
  globalRef.__grafitoGitSync__.unref?.();
}
