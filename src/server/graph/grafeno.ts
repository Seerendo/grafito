import { Grafeno } from "@grafenodb/client";
import { namespaceFor } from "./model.ts";

/**
 * Connection to Grafeno, the graph engine. GRAFENO_URL turns it on (docker-compose sets
 * http://grafeno:7810); GRAFENO_TOKEN is the server token both services share. Without a URL,
 * or while the engine does not answer, the graph is off and the rest of Grafito works as usual.
 */

const HEALTH_MS = 10_000;
const TIMEOUT_MS = 5_000;

let client: Grafeno | null | undefined;
let health: { at: number; ok: boolean; version: string } | null = null;
let probing: Promise<boolean> | null = null;

export function grafenoUrl(): string | null {
  const url = process.env.GRAFENO_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

/** Namespace prefix, so several Grafito installations can share one engine. */
export function namespacePrefix(): string {
  return process.env.GRAFENO_NAMESPACE_PREFIX?.trim() || "grafito-";
}

export function ownerNamespace(ownerId: string): string {
  return namespaceFor(namespacePrefix(), ownerId);
}

/** The shared client, or null when Grafeno is not configured. */
export function grafeno(): Grafeno | null {
  if (client !== undefined) return client;
  const url = grafenoUrl();
  // A request that hangs must not hold a page or the sync loop.
  const timed: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  client = url
    ? new Grafeno({ url, token: process.env.GRAFENO_TOKEN?.trim() || undefined, fetch: timed })
    : null;
  return client;
}

/** Whether the engine answers, checked at most every 10 s. */
export async function grafenoReachable(): Promise<boolean> {
  const engine = grafeno();
  if (!engine) return false;
  if (health && Date.now() - health.at < HEALTH_MS) return health.ok;
  probing ??= engine
    .health()
    .then((result) => {
      health = { at: Date.now(), ok: result.status === "ok", version: result.version };
      return health.ok;
    })
    .catch(() => {
      health = { at: Date.now(), ok: false, version: "" };
      return false;
    })
    .finally(() => {
      probing = null;
    });
  return probing;
}

/** Last known engine version, for monitoring. */
export function grafenoVersion(): string {
  return health?.version ?? "";
}

/** A failed call marks the engine down until the next check. */
export function markGrafenoDown(): void {
  health = { at: Date.now(), ok: false, version: health?.version ?? "" };
}
