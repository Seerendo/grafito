export const ADMIN_EMAIL = "admin@grafito.app";
export const ADMIN_INITIAL_PASSWORD = "admin";
/** Largo mínimo de una contraseña que no obliga a cambiarla al entrar. */
export const STRONG_PASSWORD = 8;

export function emailForUsername(username: string): string | null {
  const name = username.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,31})$/.test(name)) return null;
  return `${name}@grafito.app`;
}

export type EngineName = "postgres" | "pglite" | "elasticsearch" | "minio";

export function elasticUrl(): string | null {
  const value = process.env.ELASTICSEARCH_URL?.trim();
  return value || null;
}

export function objectStorageEnv(): {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
} | null {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKey = process.env.S3_ACCESS_KEY?.trim();
  const secretKey = process.env.S3_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    bucket,
    accessKey,
    secretKey,
    region: process.env.S3_REGION?.trim() || "us-east-1",
  };
}

export function relationalEngine(): "postgres" | "pglite" {
  return process.env.DATABASE_URL?.trim() ? "postgres" : "pglite";
}

export function documentEngine(): "elasticsearch" | "postgres" {
  return elasticUrl() ? "elasticsearch" : "postgres";
}

/** Dónde se guardan los bytes de los archivos (ver `server/blobs.ts`). */
export function fileEngine(): "minio" | "postgres" {
  return objectStorageEnv() ? "minio" : "postgres";
}
