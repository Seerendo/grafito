import net from "node:net";
import {
  clamavEndpoint,
  DEFAULT_CLAMAV,
  parseClamavConfig,
  parseClamdReply,
  type ClamavConfig,
  type ScanVerdict,
} from "@/domain/clamav";
import type { Sql } from "@/lib/db";
import { deleteBlob, readBlob } from "./blobs";

/**
 * Server antivirus defaults to Compose clamd at clamav:3310 until settings are saved. Enabled
 * scans stream through INSTREAM; infection or scanner failure deletes the object and rejects
 * completion.
 */

export type ClamdEndpoint = { host: string; port: number };

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
    timeoutSeconds: Number(map.get(KEYS.timeout) ?? 60),
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
      message: `El antivirus rechazó el archivo (${reply.signature}).`,
      signature: reply.signature,
      detail: reply.detail,
    };
  }
  return {
    status: 503,
    message: "El antivirus no está disponible. La subida se canceló.",
    signature: "",
    detail: reply.detail,
  };
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

export async function scanBytes(
  bytes: Uint8Array,
  endpoint: ClamdEndpoint,
  timeoutMs = 60_000,
): Promise<{ verdict: ScanVerdict; signature: string; detail: string }> {
  const payload = instream(bytes);
  const text = await clamCommand(endpoint, payload, timeoutMs);
  return parseClamdReply(text);
}

/** Send zINSTREAM, chunks prefixed by four-byte lengths, and a final empty chunk. */
function instream(bytes: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from(`zINSTREAM${NUL}`)];
  const size = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += size) {
    const slice = bytes.subarray(offset, offset + size);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(slice.length, 0);
    parts.push(length, Buffer.from(slice));
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

function clamCommand(endpoint: ClamdEndpoint, payload: Buffer, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(text ?? "");
    };
    const timer = setTimeout(
      () => finish(new Error("El antivirus no contestó a tiempo.")),
      timeoutMs,
    );
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunk.includes(0)) socket.end();
    });
    socket.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      socket.write(payload);
    });
  });
}
