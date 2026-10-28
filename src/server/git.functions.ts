import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { PERMISSION } from "@/domain/permissions";
import type { Sql } from "@/lib/db";
import { encryptionReady } from "@/server/crypto";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { allowedHost, GitError, normalizeBaseUrl, openRepo, type Provider } from "@/server/git/providers";
import {
  ALL,
  cleanFolder,
  gitEnabled,
  newHookSecret,
  readLink,
  runLink,
  sealToken,
  startGitSync,
  syncMinutes,
  type Direction,
  type LinkRow,
} from "@/server/git/sync";

/**
 * Enlazar un portafolio (o toda la bóveda) con un repositorio de GitHub o
 * GitLab: ver el estado, guardar (comprobando el acceso), sincronizar ya y
 * desconectar. Hace falta el plugin `git` encendido y el permiso `git.sync`.
 * Ver `server/git/sync.ts` y `docs/GIT.md`.
 */

const id = z.string().min(1).max(80);
const GIT_SYNC = "git.sync";

async function access(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  const ok = (await gitEnabled(sql)) && allows(profile, GIT_SYNC) && allows(profile, PERMISSION.notesRead);
  return { sql, ok };
}

async function linkFor(sql: Sql, userId: string, portfolioId: string): Promise<LinkRow | null> {
  const rows = await sql<{ id: string }>`
    select id from git_link where user_id = ${userId} and portfolio_id = ${portfolioId} limit 1
  `;
  return rows[0] ? readLink(sql, rows[0].id) : null;
}

function publicLink(link: LinkRow) {
  return {
    provider: link.provider,
    baseUrl: link.base_url,
    repo: link.repo,
    branch: link.branch,
    folder: link.folder,
    direction: link.direction,
    lastError: link.last_error,
    lastSyncAt: link.last_sync_at === null || link.last_sync_at === undefined ? null : Number(link.last_sync_at),
    lastSummary: link.last_summary,
    hookPath: `/api/git/hook/${link.id}`,
    hookSecret: link.hook_secret,
  };
}

/**
 * Acepta `grupo/proyecto` o la dirección completa del repositorio
 * (`https://gitlab.universidad.edu/grupo/sub/proyecto.git`): de ella salen
 * el servidor y la ruta.
 */
function parseRepo(provider: Provider, baseUrl: string, repo: string): { baseUrl: string; repo: string } {
  const raw = repo.trim();
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const path = url.pathname
      .replace(/\.git$/i, "")
      .split("/-/")[0]!
      .replace(/^\/+|\/+$/g, "");
    return { baseUrl: `${url.protocol}//${url.host}`, repo: path };
  }
  return { baseUrl: normalizeBaseUrl(provider, baseUrl), repo: raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "") };
}

export const gitLinkState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ portfolioId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await access(context.userId);
    if (!ok) return { available: false as const };
    const link = await linkFor(sql, context.userId, data.portfolioId);
    return {
      available: true as const,
      encryption: encryptionReady(),
      minutes: syncMinutes(),
      link: link ? publicLink(link) : null,
    };
  });

/** Los portafolios enlazados (para marcarlos en la interfaz). */
export const gitLinkedPortfolios = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, ok } = await access(context.userId);
    if (!ok) return { available: false, linked: [] as Array<{ portfolioId: string; error: boolean }> };
    const rows = await sql<{ portfolio_id: string; last_error: string }>`
      select portfolio_id, last_error from git_link where user_id = ${context.userId}
    `;
    return { available: true, linked: rows.map((row) => ({ portfolioId: row.portfolio_id, error: Boolean(row.last_error) })) };
  });

const settings = z.object({
  portfolioId: id,
  provider: z.enum(["github", "gitlab"]),
  baseUrl: z.string().max(300),
  repo: z.string().trim().min(1).max(300),
  branch: z.string().trim().min(1).max(200),
  folder: z.string().max(300),
  direction: z.enum(["both", "push", "pull"]),
  /** Vacío al editar: se conserva el guardado. */
  token: z.string().max(500),
});

export const saveGitLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => settings.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await access(context.userId);
    if (!ok) return { ok: false as const, error: "Tu rol no puede sincronizar con Git." };
    if (!encryptionReady()) return { ok: false as const, error: "El servidor no tiene clave de cifrado para guardar el token." };
    if (data.portfolioId !== ALL) {
      const exists = await sql<{ id: string }>`
        select id from vault_portfolio where user_id = ${context.userId} and id = ${data.portfolioId} and not deleted limit 1
      `;
      if (!exists[0]) return { ok: false as const, error: "Ese portafolio no existe." };
    }
    let target: { baseUrl: string; repo: string };
    try {
      target = parseRepo(data.provider, data.baseUrl, data.repo);
    } catch {
      return { ok: false as const, error: "La dirección del servidor no es válida." };
    }
    if (!target.repo.includes("/")) return { ok: false as const, error: "Escribe el repositorio como dueño/nombre (o grupo/proyecto)." };
    if (!allowedHost(target.baseUrl)) {
      return {
        ok: false as const,
        error: `${new URL(target.baseUrl).host} no está permitido. El administrador puede añadirlo en GRAFITO_GIT_HOSTS.`,
      };
    }
    const existing = await linkFor(sql, context.userId, data.portfolioId);
    const token = data.token.trim();
    if (!token && !existing) return { ok: false as const, error: "Falta el token de acceso." };
    const folder = cleanFolder(data.folder);
    const direction = data.direction as Direction;

    // Se comprueba antes de guardar: acceso, permiso de escritura y rama.
    try {
      const repo = openRepo({
        provider: data.provider,
        baseUrl: target.baseUrl,
        repo: target.repo,
        branch: data.branch,
        token: token || (await import("@/server/crypto")).decrypt(existing!.token),
      });
      const info = await repo.check();
      if (direction !== "pull" && !info.canWrite) {
        return { ok: false as const, error: "El token solo puede leer este repositorio. Usa «Solo traer» o un token con permiso de escritura." };
      }
      const head = await repo.head();
      if (!head && (data.provider === "github" || direction === "pull")) {
        return {
          ok: false as const,
          error: `La rama ${data.branch} no existe${info.defaultBranch ? ` (la principal es ${info.defaultBranch})` : ""}.`,
        };
      }
    } catch (error) {
      return { ok: false as const, error: error instanceof GitError ? error.message : "No se pudo comprobar el repositorio." };
    }

    const now = Date.now();
    const sealed = token ? sealToken(token) : existing!.token;
    if (existing) {
      const moved =
        existing.provider !== data.provider ||
        existing.base_url !== target.baseUrl ||
        existing.repo !== target.repo ||
        existing.branch !== data.branch ||
        existing.folder !== folder;
      await sql`
        update git_link set provider = ${data.provider}, base_url = ${target.baseUrl}, repo = ${target.repo},
          branch = ${data.branch}, folder = ${folder}, direction = ${direction}, token = ${sealed}, pending = true,
          last_error = '', head = ${moved ? null : existing.head}
        where id = ${existing.id}
      `;
      // Otro repositorio u otra carpeta: se empieza de cero (nada se borra en ningún lado).
      if (moved) {
        await sql`delete from git_link_file where link_id = ${existing.id}`;
        await sql`update git_link set last_summary = '' where id = ${existing.id}`;
      }
    } else {
      await sql`
        insert into git_link (id, user_id, portfolio_id, provider, base_url, repo, branch, folder, direction, token,
          hook_secret, pending, created_at)
        values (${crypto.randomUUID()}, ${context.userId}, ${data.portfolioId}, ${data.provider}, ${target.baseUrl},
          ${target.repo}, ${data.branch}, ${folder}, ${direction}, ${sealed}, ${newHookSecret()}, true, ${now})
      `;
    }
    startGitSync();
    const link = await linkFor(sql, context.userId, data.portfolioId);
    // La primera vuelta ya, sin esperar al temporizador.
    const result = link ? await runLink(sql, link.id) : null;
    const fresh = await linkFor(sql, context.userId, data.portfolioId);
    return { ok: true as const, link: fresh ? publicLink(fresh) : null, message: result?.message ?? "" };
  });

export const syncGitNow = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ portfolioId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await access(context.userId);
    if (!ok) return { ok: false as const, error: "Tu rol no puede sincronizar con Git." };
    const link = await linkFor(sql, context.userId, data.portfolioId);
    if (!link) return { ok: false as const, error: "Este portafolio no está enlazado." };
    startGitSync();
    const result = await runLink(sql, link.id);
    const fresh = await linkFor(sql, context.userId, data.portfolioId);
    return { ok: true as const, synced: result.ok, message: result.message, link: fresh ? publicLink(fresh) : null };
  });

/** Desconecta: el repositorio y los documentos de Grafito quedan como están. */
export const removeGitLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ portfolioId: id }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, ok } = await access(context.userId);
    if (!ok) return { ok: false as const };
    await sql`delete from git_link where user_id = ${context.userId} and portfolio_id = ${data.portfolioId}`;
    return { ok: true as const };
  });
