import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Cifrado de secretos en la base (solo servidor): AES-256-GCM con una clave
 * derivada de `GRAFITO_ENCRYPTION_KEY`, que vive en el entorno y no en la base,
 * así que un respaldo robado de la base no basta para leer los tokens.
 *
 * Formato guardado: `v1:<iv>:<tag>:<cifrado>` (base64url).
 */

const VERSION = "v1";

export class EncryptionUnavailable extends Error {
  constructor() {
    super("Falta GRAFITO_ENCRYPTION_KEY en el servidor: no se pueden guardar claves.");
  }
}

function key(): Buffer {
  const raw = process.env.GRAFITO_ENCRYPTION_KEY?.trim();
  if (!raw || raw.length < 32) throw new EncryptionUnavailable();
  return createHash("sha256").update(raw).digest();
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

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Secreto con formato desconocido.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
