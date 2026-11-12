import { CLIENT_VERSION, Grafeno } from "@grafenodb/client";
import { namespaceFor } from "./model.ts";

/**
 * Connection to Grafeno, the graph engine. GRAFENO_URL turns it on (docker-compose sets
 * http://grafeno:7810); GRAFENO_TOKEN is the server token both services share. Without a URL,
 * or while the engine does not answer, the graph is off and the rest of Grafito works as usual.
 */

const HEALTH_MS = 10_000;
const TIMEOUT_MS = 5_000;

let client: Grafeno | null | undefined;
let health: { at: number; ok: boolean; version: string; problem: string } | null = null;
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

const SLOW_MS = 120_000;
let slow: Grafeno | null | undefined;

/** A client for the background analysis, whose queries take seconds on a large vault. */
export function grafenoSlow(): Grafeno | null {
  if (slow !== undefined) return slow;
  const url = grafenoUrl();
  const timed: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(SLOW_MS) });
  slow = url
    ? new Grafeno({ url, token: process.env.GRAFENO_TOKEN?.trim() || undefined, fetch: timed })
    : null;
  return slow;
}

/**
 * Whether the engine answers and speaks an API version this SDK speaks, checked at most every
 * 10 s. The image installs the latest SDK at every build (Dockerfile), so a future SDK that no
 * longer speaks the running engine's API turns the graph off with a reason instead of failing
 * queries one by one.
 */
export async function grafenoReachable(): Promise<boolean> {
  const engine = grafeno();
  if (!engine) return false;
  if (health && Date.now() - health.at < HEALTH_MS) return health.ok;
  probing ??= engine
    .connect()
    .then((about) => {
      health = { at: Date.now(), ok: true, version: about.version, problem: "" };
      return true;
    })
    .catch((error: unknown) => {
      const incompatible =
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "incompatible";
      health = {
        at: Date.now(),
        ok: false,
        version: health?.version ?? "",
        problem: incompatible
          ? `El SDK de Grafeno ${CLIENT_VERSION} no es compatible con este motor: ${error.message}`
          : "",
      };
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

/** Why the engine is not used although it answers (an SDK that does not speak its API), or "". */
export function grafenoProblem(): string {
  return health?.problem ?? "";
}

/** The SDK version this build carries. */
export function sdkVersion(): string {
  return CLIENT_VERSION;
}

/** A failed call marks the engine down until the next check. */
export function markGrafenoDown(): void {
  health = { at: Date.now(), ok: false, version: health?.version ?? "", problem: "" };
}
