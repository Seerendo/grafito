import { AwsClient } from "aws4fetch";
import type { Sql } from "@/lib/db";
import { objectStorageEnv } from "./platform";

/**
 * Bytes de los archivos (solo servidor). Con `S3_*` van a MinIO / S3; sin
 * ellas, a la tabla `file_blob` de Postgres. Ver `migrations/0011_file_storage.sql`.
 *
 * Las subidas son siempre por partes (`PART_SIZE`), en orden: en S3 es una
 * subida multiparte; en Postgres cada parte se añade al final de la fila.
 */

/** Tamaño de cada parte. S3 exige al menos 5 MiB salvo en la última. */
export const PART_SIZE = 8 * 1024 * 1024;

/** Tope por archivo: `GRAFITO_MAX_UPLOAD_MB`, o 100 MB con S3 y 20 MB en Postgres. */
export function maxUploadBytes(): number {
  const configured = Number(process.env.GRAFITO_MAX_UPLOAD_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : objectStorageEnv() ? 100 : 20;
  return Math.floor(megabytes * 1024 * 1024);
}

export function blobBackend(): "s3" | "postgres" {
  return objectStorageEnv() ? "s3" : "postgres";
}

type S3 = { client: AwsClient; base: string };

function s3(): S3 | null {
  const env = objectStorageEnv();
  if (!env) return null;
  return {
    client: new AwsClient({
      accessKeyId: env.accessKey,
      secretAccessKey: env.secretKey,
      service: "s3",
      region: env.region,
    }),
    base: `${env.endpoint}/${encodeURIComponent(env.bucket)}`,
  };
}

function objectUrl(store: S3, key: string, query = ""): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${store.base}/${path}${query ? `?${query}` : ""}`;
}

async function expectOk(response: Response, action: string): Promise<Response> {
  if (response.ok) return response;
  const detail = await response.text().catch(() => "");
  throw new Error(`Almacenamiento de archivos: ${action} respondió ${response.status}. ${detail.slice(0, 200)}`);
}

/** Empieza una subida; devuelve el identificador que piden las partes. */
export async function startUpload(sql: Sql, key: string, mime: string): Promise<string> {
  const store = s3();
  if (!store) {
    await sql`insert into file_blob (key, data) values (${key}, ''::bytea) on conflict (key) do update set data = ''::bytea`;
    return key;
  }
  const response = await expectOk(
    await store.client.fetch(objectUrl(store, key, "uploads="), { method: "POST", headers: { "content-type": mime } }),
    "iniciar la subida",
  );
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())?.[1];
  if (!uploadId) throw new Error("Almacenamiento de archivos: no devolvió el identificador de la subida.");
  return uploadId;
}

/** Sube la parte `part` (desde 1). Devuelve su ETag (vacío en Postgres). */
export async function uploadPart(sql: Sql, key: string, uploadId: string, part: number, bytes: Uint8Array): Promise<string> {
  const store = s3();
  if (!store) {
    await sql`update file_blob set data = data || ${bytes} where key = ${key}`;
    return "";
  }
  const query = `partNumber=${part}&uploadId=${encodeURIComponent(uploadId)}`;
  const response = await expectOk(
    await store.client.fetch(objectUrl(store, key, query), { method: "PUT", body: bytes as Uint8Array<ArrayBuffer> }),
    "subir una parte",
  );
  return response.headers.get("etag") ?? "";
}

/** Cierra la subida y devuelve el tamaño final. */
export async function finishUpload(
  sql: Sql,
  key: string,
  uploadId: string,
  parts: { part: number; etag: string }[],
): Promise<number> {
  const store = s3();
  if (!store) {
    const rows = await sql<{ size: number }>`select length(data) as size from file_blob where key = ${key}`;
    if (!rows[0]) throw new Error("La subida no existe.");
    return Number(rows[0].size);
  }
  const body =
    "<CompleteMultipartUpload>" +
    parts
      .sort((a, b) => a.part - b.part)
      .map((item) => `<Part><PartNumber>${item.part}</PartNumber><ETag>${escapeXml(item.etag)}</ETag></Part>`)
      .join("") +
    "</CompleteMultipartUpload>";
  const response = await expectOk(
    await store.client.fetch(objectUrl(store, key, `uploadId=${encodeURIComponent(uploadId)}`), {
      method: "POST",
      body,
      headers: { "content-type": "application/xml" },
    }),
    "cerrar la subida",
  );
  const text = await response.text();
  if (text.includes("<Error>")) throw new Error("Almacenamiento de archivos: no se pudo cerrar la subida.");
  const head = await expectOk(await store.client.fetch(objectUrl(store, key), { method: "HEAD" }), "leer el tamaño");
  return Number(head.headers.get("content-length") ?? 0);
}

/** Cancela una subida a medias. */
export async function abortUpload(sql: Sql, key: string, uploadId: string): Promise<void> {
  const store = s3();
  if (!store) {
    await sql`delete from file_blob where key = ${key}`;
    return;
  }
  await store.client
    .fetch(objectUrl(store, key, `uploadId=${encodeURIComponent(uploadId)}`), { method: "DELETE" })
    .catch(() => undefined);
}

/** Guarda unos bytes de una vez (archivos pequeños, migración de los antiguos). */
export async function putBlob(sql: Sql, key: string, bytes: Uint8Array, mime: string): Promise<void> {
  const store = s3();
  if (!store) {
    await sql`insert into file_blob (key, data) values (${key}, ${bytes}) on conflict (key) do update set data = excluded.data`;
    return;
  }
  await expectOk(
    await store.client.fetch(objectUrl(store, key), { method: "PUT", body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": mime } }),
    "guardar el archivo",
  );
}

/**
 * Lee un archivo. Con S3 se pasa `range` (cabecera Range del navegador) para
 * que los PDF y vídeos se puedan leer a trozos.
 */
export async function getBlob(
  sql: Sql,
  key: string,
  range?: string | null,
): Promise<{ body: ReadableStream<Uint8Array> | Uint8Array; status: number; headers: Record<string, string> } | null> {
  const store = s3();
  if (!store) {
    const rows = await sql<{ data: Uint8Array }>`select data from file_blob where key = ${key} limit 1`;
    if (!rows[0]) return null;
    const data = new Uint8Array(rows[0].data);
    return { body: data, status: 200, headers: { "content-length": String(data.byteLength) } };
  }
  const response = await store.client.fetch(objectUrl(store, key), {
    method: "GET",
    headers: range ? { range } : {},
  });
  if (response.status === 404) return null;
  await expectOk(response, "leer el archivo");
  const headers: Record<string, string> = {};
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return { body: response.body ?? new Uint8Array(), status: response.status, headers };
}

/** Lee un archivo entero en memoria (para la IA o la API de texto). */
export async function readBlob(sql: Sql, key: string): Promise<Uint8Array | null> {
  const blob = await getBlob(sql, key);
  if (!blob) return null;
  if (blob.body instanceof Uint8Array) return blob.body;
  return new Uint8Array(await new Response(blob.body).arrayBuffer());
}

export async function deleteBlob(sql: Sql, key: string): Promise<void> {
  const store = s3();
  if (!store) {
    await sql`delete from file_blob where key = ${key}`;
    return;
  }
  await store.client.fetch(objectUrl(store, key), { method: "DELETE" }).catch(() => undefined);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
