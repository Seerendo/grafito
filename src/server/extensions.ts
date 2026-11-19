import type { Sql } from "@/lib/db";
import { canSwitch, extensionActive as activeFor } from "@/domain/extensions";
import { grafeno, grafenoProblem, grafenoReachable } from "./graph/grafeno";
import { latexUrl } from "./latex";
import { ocrUrl } from "./ocr";

/**
 * Extensions (the app_plugin table). An extension that needs a service is checked before it can
 * be turned on, and only runs while the check passes: Grafo needs Grafeno, LaTeX the latex
 * service, OCR the ocr service. One that is on but loses its service is paused, not turned off,
 * and runs again when the service answers; its background work (graph sync, OCR queue) picks up
 * where it stopped. Mermaid, Vínculos and Git need no service of their own.
 */

export type ExtensionCheck = {
  /** The check passed (or the extension needs no service). */
  ok: boolean;
  /** Needs a service at all. */
  service: boolean;
  /** Why it failed, for the administrator. */
  detail: string;
};

const CACHE_MS = 10_000;
const PROBE_MS = 3_000;
const cache = new Map<string, { at: number; check: ExtensionCheck }>();

const NO_SERVICE: ExtensionCheck = { ok: true, service: false, detail: "" };

async function health(url: string | null, what: string): Promise<ExtensionCheck> {
  if (!url) return { ok: false, service: true, detail: `${what} no está configurado.` };
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    return response.ok
      ? { ok: true, service: true, detail: "" }
      : { ok: false, service: true, detail: `${what} respondió ${response.status}.` };
  } catch {
    return { ok: false, service: true, detail: `${what} no responde.` };
  }
}

async function probe(id: string): Promise<ExtensionCheck> {
  switch (id) {
    case "grafo": {
      if (!grafeno()) return { ok: false, service: true, detail: "Grafeno no está configurado." };
      const ok = await grafenoReachable();
      return { ok, service: true, detail: ok ? "" : grafenoProblem() || "Grafeno no responde." };
    }
    case "latex":
      return health(latexUrl(), "El compilador de LaTeX");
    case "ocr":
      return health(ocrUrl(), "El servicio de OCR");
    default:
      return NO_SERVICE;
  }
}

/** The extension's check, at most every 10 s unless `fresh`. */
export async function checkExtension(id: string, fresh = false): Promise<ExtensionCheck> {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.check;
  const check = await probe(id);
  cache.set(id, { at: Date.now(), check });
  return check;
}

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

/** Turned on by an administrator (an extension without a row is on). */
export async function extensionChosen(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ enabled: unknown }>`
    select enabled from app_plugin where id = ${id} limit 1
  `;
  return !rows[0] || flag(rows[0].enabled);
}

/** On and its service answering: what the app goes by. */
export async function extensionActive(sql: Sql, id: string): Promise<boolean> {
  return activeFor(await extensionChosen(sql, id), await checkExtension(id));
}

export type ExtensionState = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  builtIn: boolean;
  check: ExtensionCheck;
  /** enabled and the check passed. */
  active: boolean;
};

export async function readExtensions(sql: Sql, fresh = false): Promise<ExtensionState[]> {
  const rows = await sql<{
    id: string;
    name: string;
    description: string;
    enabled: unknown;
    built_in: unknown;
  }>`select id, name, description, enabled, built_in from app_plugin order by name`;
  return Promise.all(
    rows.map(async (row) => {
      const check = await checkExtension(row.id, fresh);
      const enabled = flag(row.enabled);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        enabled,
        builtIn: flag(row.built_in),
        check,
        active: activeFor(enabled, check),
      };
    }),
  );
}

/**
 * Turn an extension on or off. Turning it on runs the check first and refuses when it fails;
 * turning it off always works.
 */
export async function setExtension(
  sql: Sql,
  id: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql<{ id: string }>`select id from app_plugin where id = ${id} limit 1`;
  if (!rows[0]) return { ok: false, error: "Esa extensión no existe." };
  if (enabled) {
    const check = await checkExtension(id, true);
    if (!canSwitch(false, check))
      return { ok: false, error: check.detail || "La comprobación falló." };
  }
  await sql`update app_plugin set enabled = ${enabled} where id = ${id}`;
  return { ok: true };
}
