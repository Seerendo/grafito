import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Cifrado de secretos en la base (solo servidor): AES-256-GCM con una clave
 * derivada de `GRAFITO_ENCRYPTION_KEY`, que vive en el entorno y no en la base,
 * así que un respaldo robado de la base no basta para leer los tokens.
 *
 * Formato guardado: `v1:<iv>:<tag>:<cifrado>` (base64url).
 *
 * Rotación: se pone la clave nueva en `GRAFITO_ENCRYPTION_KEY` y la anterior en
 * `GRAFITO_ENCRYPTION_KEY_PREVIOUS`. Lo cifrado con la anterior se sigue
 * leyendo (`open` avisa con `stale`) y quien lo lee lo vuelve a cifrar con la
 * nueva. Ver docs/OPERATIONS.md.
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
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

function decryptWith(secret: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Secreto con formato desconocido.");
  const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Descifra con la clave actual o, durante una rotación, con la anterior. */
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
