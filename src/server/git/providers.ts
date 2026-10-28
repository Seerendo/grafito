import { createHash } from "node:crypto";

/**
 * Repositorios de GitHub y GitLab por su API REST (solo servidor), sin el
 * programa `git`: leer la rama, el árbol y los blobs, y hacer un commit con
 * varios cambios. Sirve para github.com, gitlab.com e instalaciones propias
 * (GitHub Enterprise Server, un GitLab institucional), siempre que su
 * servidor esté permitido (`allowedHost`, `GRAFITO_GIT_HOSTS`).
 */

export type Provider = "github" | "gitlab";

export type RepoConfig = { provider: Provider; baseUrl: string; repo: string; branch: string; token: string };

export type RemoteFile = { path: string; sha: string };

/** Un cambio de un commit: el contenido nuevo de una ruta, o `null` para borrarla. */
export type Change = { path: string; bytes: Uint8Array | null; exists: boolean };

export class GitError extends Error {
  constructor(
    message: string,
    /** La rama avanzó mientras tanto: se reintenta en la siguiente vuelta. */
    readonly retry = false,
  ) {
    super(message);
  }
}

export const DEFAULT_URL: Record<Provider, string> = { github: "https://github.com", gitlab: "https://gitlab.com" };

/** El id que Git le da a un contenido (`git hash-object`). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Servidores a los que se puede conectar: github.com y gitlab.com, más los que
 * el administrador añada en `GRAFITO_GIT_HOSTS` (separados por comas). Así un
 * usuario no puede hacer que el servidor llame a cualquier dirección interna.
 */
export function allowedHost(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.host.toLowerCase();
  const extra = (process.env.GRAFITO_GIT_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (extra.includes(host) || extra.includes(url.hostname.toLowerCase())) return true;
  return url.protocol === "https:" && (host === "github.com" || host === "gitlab.com");
}

/** La dirección del servidor sin barra final ni ruta de más. */
export function normalizeBaseUrl(provider: Provider, raw: string): string {
  const value = raw.trim() || DEFAULT_URL[provider];
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Explica un fallo de red, en especial el certificado de un servidor propio. */
function networkError(error: unknown, baseUrl: string): GitError {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  const host = new URL(baseUrl).host;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return new GitError(
      `El certificado de ${host} no es de confianza para el servidor de Grafito. Añade su autoridad con NODE_EXTRA_CA_CERTS (ver docs/GIT.md).`,
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new GitError(`No se encuentra ${host} desde el servidor de Grafito.`);
  return new GitError(`No se pudo conectar con ${host}${code ? ` (${code})` : ""}.`);
}

async function call(
  config: RepoConfig,
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
  if (!allowedHost(config.baseUrl)) {
    throw new GitError(`${new URL(config.baseUrl).host} no está permitido. El administrador puede añadirlo en GRAFITO_GIT_HOSTS.`);
  }
  let response: Response;
  try {
    // Sin seguir redirecciones: podrían llevar el token a otra dirección.
    response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw networkError(error, config.baseUrl);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GitError("El servidor respondió con una redirección: revisa la dirección del servidor o si el repositorio cambió de nombre.");
  }
  return response;
}

async function failure(response: Response, what: string): Promise<GitError> {
  let detail = "";
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;
    detail = typeof message === "string" ? message : message ? JSON.stringify(message) : "";
  } catch {
    // Sin cuerpo JSON.
  }
  const extra = detail ? ` (${detail.slice(0, 200)})` : "";
  if (response.status === 401) return new GitError(`El token no es válido o caducó${extra}.`);
  if (response.status === 403) return new GitError(`El token no tiene permiso para ${what}${extra}.`);
  if (response.status === 404) return new GitError(`No se encuentra el repositorio o la rama, o el token no tiene acceso${extra}.`);
  if (response.status === 409 || response.status === 422) return new GitError(`La rama cambió mientras tanto${extra}.`, true);
  return new GitError(`Error ${response.status} al ${what}${extra}.`);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export interface GitRepo {
  /** Comprueba el acceso; `canWrite` si el token puede hacer commits. */
  check(): Promise<{ canWrite: boolean; defaultBranch: string | null }>;
  /** El último commit de la rama, o `null` si la rama no existe. */
  head(): Promise<string | null>;
  /** Los archivos (no carpetas) de un commit. */
  tree(commit: string): Promise<RemoteFile[]>;
  readBlob(sha: string): Promise<Uint8Array>;
  /**
   * Un commit con todos los cambios sobre `parent` (`null`: la rama aún no
   * existe; solo GitLab la crea así). Devuelve el nuevo commit.
   */
  commit(parent: string | null, message: string, changes: Change[]): Promise<string>;
}

export function openRepo(config: RepoConfig): GitRepo {
  return config.provider === "github" ? github(config) : gitlab(config);
}

// ---------------------------------------------------------------------------
// GitHub (github.com y GitHub Enterprise Server)

function github(config: RepoConfig): GitRepo {
  const host = new URL(config.baseUrl).host;
  const api = host === "github.com" ? "https://api.github.com" : `${config.baseUrl}/api/v3`;
  const repo = config.repo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Grafito",
  };
  const get = async <T>(path: string, what: string): Promise<T> => {
    const response = await call(config, `${api}/repos/${repo}${path}`, { headers });
    if (!response.ok) throw await failure(response, what);
    return (await response.json()) as T;
  };
  const send = async <T>(method: string, path: string, body: unknown, what: string): Promise<T> => {
    const response = await call(config, `${api}/repos/${repo}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response, what);
    return (await response.json()) as T;
  };
  return {
    async check() {
      const info = await get<{ permissions?: { push?: boolean }; default_branch?: string }>("", "leer el repositorio");
      return { canWrite: Boolean(info.permissions?.push), defaultBranch: info.default_branch ?? null };
    },
    async head() {
      const response = await call(config, `${api}/repos/${repo}/branches/${encodeURIComponent(config.branch)}`, { headers });
      if (response.status === 404) {
        // ¿No existe la rama, o el repositorio? Lo segundo es un error.
        await get("", "leer el repositorio");
        return null;
      }
      if (!response.ok) throw await failure(response, "leer la rama");
      return ((await response.json()) as { commit: { sha: string } }).commit.sha;
    },
    async tree(commit) {
      const info = await get<{ tree: { sha: string } }>(`/git/commits/${commit}`, "leer el commit");
      const tree = await get<{ tree: Array<{ path: string; type: string; sha: string }>; truncated?: boolean }>(
        `/git/trees/${info.tree.sha}?recursive=1`,
        "leer los archivos",
      );
      if (tree.truncated) throw new GitError("El repositorio tiene demasiados archivos para leerlos de una vez.");
      return tree.tree.filter((item) => item.type === "blob").map((item) => ({ path: item.path, sha: item.sha }));
    },
    async readBlob(sha) {
      const blob = await get<{ content: string; encoding: string }>(`/git/blobs/${sha}`, "leer un archivo");
      return new Uint8Array(Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8"));
    },
    async commit(parent, message, changes) {
      if (!parent) {
        throw new GitError(
          `La rama ${config.branch} no existe. En GitHub, créala con un primer commit (por ejemplo, un README) y vuelve a intentarlo.`,
        );
      }
      const base = await get<{ tree: { sha: string } }>(`/git/commits/${parent}`, "leer el commit");
      const entries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
      for (const change of changes) {
        if (!change.bytes) {
          if (change.exists) entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
          continue;
        }
        const blob = await send<{ sha: string }>(
          "POST",
          "/git/blobs",
          { content: toBase64(change.bytes), encoding: "base64" },
          "subir un archivo",
        );
        entries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const tree = await send<{ sha: string }>("POST", "/git/trees", { base_tree: base.tree.sha, tree: entries }, "preparar el commit");
      const commit = await send<{ sha: string }>("POST", "/git/commits", { message, tree: tree.sha, parents: [parent] }, "hacer el commit");
      await send("PATCH", `/git/refs/heads/${encodeURIComponent(config.branch)}`, { sha: commit.sha, force: false }, "actualizar la rama");
      return commit.sha;
    },
  };
}

// ---------------------------------------------------------------------------
// GitLab (gitlab.com e instalaciones propias, con subgrupos)

function gitlab(config: RepoConfig): GitRepo {
  const api = `${config.baseUrl}/api/v4/projects/${encodeURIComponent(config.repo)}`;
  // Vale para tokens personales, de proyecto y de grupo.
  const headers = { "private-token": config.token, "user-agent": "Grafito" };
  const get = async <T>(path: string, what: string): Promise<{ body: T; response: Response }> => {
    const response = await call(config, `${api}${path}`, { headers });
    if (!response.ok) throw await failure(response, what);
    return { body: (await response.json()) as T, response };
  };
  return {
    async check() {
      const { body } = await get<{
        default_branch?: string;
        permissions?: { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null };
      }>("", "leer el proyecto");
      const level = Math.max(
        body.permissions?.project_access?.access_level ?? 0,
        body.permissions?.group_access?.access_level ?? 0,
      );
      // 30 = Developer. Un token de proyecto puede no traer `permissions`: se prueba al hacer el commit.
      return { canWrite: level >= 30 || !body.permissions, defaultBranch: body.default_branch ?? null };
    },
    async head() {
      const response = await call(config, `${api}/repository/branches/${encodeURIComponent(config.branch)}`, { headers });
      if (response.status === 404) {
        await get("", "leer el proyecto");
        return null;
      }
      if (!response.ok) throw await failure(response, "leer la rama");
      return ((await response.json()) as { commit: { id: string } }).commit.id;
    },
    async tree(commit) {
      const out: RemoteFile[] = [];
      for (let page = 1; page < 1000; page += 1) {
        const { body, response } = await get<Array<{ path: string; type: string; id: string }>>(
          `/repository/tree?ref=${commit}&recursive=true&per_page=100&page=${page}`,
          "leer los archivos",
        );
        for (const item of body) if (item.type === "blob") out.push({ path: item.path, sha: item.id });
        if (!response.headers.get("x-next-page")) break;
      }
      return out;
    },
    async readBlob(sha) {
      const response = await call(config, `${api}/repository/blobs/${sha}/raw`, { headers });
      if (!response.ok) throw await failure(response, "leer un archivo");
      return new Uint8Array(await response.arrayBuffer());
    },
    async commit(parent, message, changes) {
      // GitLab no comprueba el commit de partida: si la rama avanzó, se deja para la siguiente vuelta.
      if ((await this.head()) !== parent) throw new GitError("La rama cambió mientras tanto.", true);
      const actions = changes
        .filter((change) => change.bytes || change.exists)
        .map((change) =>
          change.bytes
            ? {
                action: change.exists ? "update" : "create",
                file_path: change.path,
                content: toBase64(change.bytes),
                encoding: "base64",
              }
            : { action: "delete", file_path: change.path },
        );
      const response = await call(config, `${api}/repository/commits`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ branch: config.branch, commit_message: message, actions }),
      });
      if (!response.ok) throw await failure(response, "hacer el commit");
      return ((await response.json()) as { id: string }).id;
    },
  };
}
