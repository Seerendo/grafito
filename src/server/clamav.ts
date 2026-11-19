import {
  clamavEndpoint,
  DEFAULT_CLAMAV,
  parseClamavConfig,
  type ClamavConfig,
  infectedMessage,
  scanFailure,
  type ScanVerdict,
} from "@/domain/clamav";
import type { Sql } from "@/lib/db";
import { deleteBlob, readBlob } from "./blobs";
import { clamCommand, scanBytes, type ClamdEndpoint } from "./clamd-socket";

export { scanBytes, type ClamdEndpoint };

/**
 * Server antivirus defaults to Compose clamd at clamav:3310 until settings are saved. Enabled
 * scans stream through INSTREAM (clamd-socket.ts); infection or scanner failure deletes the
 * object and rejects completion.
 */

const NUL = String.fromCharCode(0);

const KEYS = {
  enabled: "clamav_enabled",
  host: "clamav_host",
  port: "clamav_port",
  timeout: "clamav_timeout_seconds",
} as const;

export type ClamavSettings = ClamavConfig & { source: "saved" | "default" };

/** Installation scanner settings, defaulting to enabled clamav:3310. */
export async function readClamavSettings(sql: Sql): Promise<ClamavSettings> {
  const rows = await sql<{ key: string; value: string }>`
    select key, value from app_setting
    where key in (${KEYS.enabled}, ${KEYS.host}, ${KEYS.port}, ${KEYS.timeout})
  `;
  const map = new Map(rows.map((row) => [row.key, row.value]));
  if (!map.has(KEYS.enabled)) return { ...DEFAULT_CLAMAV, source: "default" };
  const parsed = parseClamavConfig({
    enabled: map.get(KEYS.enabled) === "1",
    host: map.get(KEYS.host) ?? "",
    port: Number(map.get(KEYS.port) ?? 3310),
    timeoutSeconds: Number(map.get(KEYS.timeout) ?? DEFAULT_CLAMAV.timeoutSeconds),
  });
  // Unreadable settings must not disable scanning; fall back to defaults.
  if (!parsed.ok) return { ...DEFAULT_CLAMAV, source: "default" };
  return { ...parsed.config, source: "saved" };
}

export async function writeClamavSettings(sql: Sql, config: ClamavConfig): Promise<void> {
  const pairs: [string, string][] = [
    [KEYS.enabled, config.enabled ? "1" : "0"],
    [KEYS.host, config.host],
    [KEYS.port, String(config.port)],
    [KEYS.timeout, String(config.timeoutSeconds)],
  ];
  for (const [key, value] of pairs) {
    await sql`
      insert into app_setting (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value
    `;
  }
}

export type ScanBlock = { status: number; message: string; signature: string; detail: string };

/**
 * null means the object may remain because scanning is disabled or clean. Otherwise return the
 * reason after deleting it.
 */
export async function blockUnsafeBlob(sql: Sql, key: string): Promise<ScanBlock | null> {
  const settings = await readClamavSettings(sql);
  const endpoint = clamavEndpoint(settings);
  if (!endpoint) return null;
  const bytes = await readBlob(sql, key);
  if (!bytes) {
    await deleteBlob(sql, key).catch(() => undefined);
    return {
      status: 503,
      message: "El antivirus no pudo leer el archivo. La subida se canceló.",
      signature: "",
      detail: "no se pudo leer el archivo",
    };
  }
  let reply: { verdict: ScanVerdict; signature: string; detail: string };
  try {
    reply = await scanBytes(bytes, endpoint, settings.timeoutSeconds * 1000);
  } catch (error) {
    reply = {
      verdict: "error",
      signature: "",
      detail: error instanceof Error ? error.message : "sin conexión",
    };
  }
  if (reply.verdict === "clean") return null;
  await deleteBlob(sql, key).catch(() => undefined);
  if (reply.verdict === "infected") {
    return {
      status: 422,
      message: infectedMessage(reply.signature),
      signature: reply.signature,
      detail: reply.detail,
    };
  }
  return { ...scanFailure(reply.detail), signature: "", detail: reply.detail };
}

export async function probeClamd(sql: Sql): Promise<"off" | "up" | "down"> {
  const settings = await readClamavSettings(sql);
  return pingEndpoint(clamavEndpoint(settings));
}

/** Probe clamd without persisting settings; off means no configured host. */
export async function pingEndpoint(endpoint: ClamdEndpoint | null): Promise<"off" | "up" | "down"> {
  if (!endpoint) return "off";
  try {
    const text = await clamCommand(endpoint, Buffer.from(`zPING${NUL}`), 4000);
    return text.includes("PONG") ? "up" : "down";
  } catch {
    return "down";
  }
}
