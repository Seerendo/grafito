import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Server secret encryption uses AES-256-GCM with an environment-derived key, separate from
 * database backups. Persist v1:iv:tag:ciphertext in base64url. During rotation, read with the
 * current or previous key; open marks old-key data stale for re-encryption. See
 * docs/OPERATIONS.md.
 */

const VERSION = "v1";

export class EncryptionUnavailable extends Error {
  constructor() {
    super("Falta GRAFITO_ENCRYPTION_KEY en el servidor: no se pueden guardar claves.");
  }
}

function derive(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value || value.length < 32) return null;
  return createHash("sha256").update(value).digest();
}

function key(): Buffer {
  const current = derive(process.env.GRAFITO_ENCRYPTION_KEY);
  if (!current) throw new EncryptionUnavailable();
  return current;
}

export function encryptionReady(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    data.toString("base64url"),
  ].join(":");
}

function decryptWith(secret: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined)
    throw new Error("Secreto con formato desconocido.");
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Decrypt with the current key or previous rotation key. */
export function open(sealed: string): { value: string; stale: boolean } {
  try {
    return { value: decryptWith(key(), sealed), stale: false };
  } catch (error) {
    const previous = derive(process.env.GRAFITO_ENCRYPTION_KEY_PREVIOUS);
    if (!previous || error instanceof EncryptionUnavailable) throw error;
    return { value: decryptWith(previous, sealed), stale: true };
  }
}

export function decrypt(sealed: string): string {
  return open(sealed).value;
}
