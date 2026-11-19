import net from "node:net";
import { parseClamdReply, type ScanVerdict } from "../domain/clamav.ts";

/**
 * clamd over TCP: INSTREAM scans and PING. Kept free of app imports so tests can run it
 * against a fake clamd.
 */

export type ClamdEndpoint = { host: string; port: number };

const NUL = String.fromCharCode(0);

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

export function clamCommand(
  endpoint: ClamdEndpoint,
  payload: Buffer,
  timeoutMs: number,
): Promise<string> {
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
    // clamd may close right after its reply (a hit, or a size-limit error): a reset that comes
    // after the reply must not hide it.
    socket.on("error", (error) =>
      chunks.length > 0 ? finish(undefined, Buffer.concat(chunks).toString("utf8")) : finish(error),
    );
    socket.on("close", () => {
      if (chunks.length > 0) finish(undefined, Buffer.concat(chunks).toString("utf8"));
    });
    // No encoding is set, so chunks are Buffers (Node 26 types allow strings too).
    socket.on("data", (data: Buffer | string) => {
      const chunk = typeof data === "string" ? Buffer.from(data) : data;
      chunks.push(chunk);
      if (chunk.includes(0)) socket.end();
    });
    socket.on("end", () => finish(undefined, Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => {
      socket.write(payload);
    });
  });
}
