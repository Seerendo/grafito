import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installation secrets sign sessions/file/WOPI tokens and encrypt AI/SMTP credentials. Replace
 * missing or publicly known example values with random secrets in GRAFITO_SECRETS_DIR, separate
 * from database backups. Preserve the legacy encryption key as PREVIOUS when needed so old
 * ciphertext can be read and re-encrypted.
 */

/** Public example values must never be accepted as secrets. */
const PUBLIC_DEFAULTS: Record<string, string[]> = {
  BETTER_AUTH_SECRET: ["grafito-dev-secret-cambia-esto"],
  GRAFITO_ENCRYPTION_KEY: ["grafito-dev-encryption-key-cambia-esto-0001"],
};

let done = false;

function secretsDir(): string {
  return process.env.GRAFITO_SECRETS_DIR?.trim() || join(process.cwd(), ".data", "secrets");
}

function readOrCreate(dir: string, name: string): string {
  const file = join(dir, name);
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 32) return stored;
  }
  mkdirSync(dir, { recursive: true });
  const value = randomBytes(48).toString("base64url");
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Platforms without POSIX permissions. */
  }
  return value;
}

/** Initialize missing/example environment secrets once per process. */
export function ensureInstallSecrets(): void {
  if (done) return;
  done = true;
  installSecrets(process.env, secretsDir());
}

/** Apply secret initialization to an explicit environment and folder; report changes. */
export function installSecrets(env: Record<string, string | undefined>, dir: string): string[] {
  const changed: string[] = [];
  for (const name of Object.keys(PUBLIC_DEFAULTS)) {
    const current = env[name]?.trim() ?? "";
    const isPublic = PUBLIC_DEFAULTS[name]!.includes(current);
    if (current && !isPublic) continue;
    let value: string;
    try {
      value = readOrCreate(dir, name);
    } catch (error) {
      // Without writable persistent storage, use a per-process random secret rather than the public example.
      value = randomBytes(48).toString("base64url");
      console.error(`[grafito] No se pudo guardar ${name} en ${dir}:`, error);
    }
    // Legacy Compose deployments may have encrypted with the example key; preserve read compatibility.
    if (name === "GRAFITO_ENCRYPTION_KEY" && !env.GRAFITO_ENCRYPTION_KEY_PREVIOUS?.trim()) {
      env.GRAFITO_ENCRYPTION_KEY_PREVIOUS = PUBLIC_DEFAULTS[name]![0];
    }
    env[name] = value;
    changed.push(name);
    console.warn(
      `[grafito] ${name} ${isPublic ? "tenía el valor de ejemplo público" : "no está definido"}: ` +
        `se usa uno propio de esta instalación (${join(dir, name)}).`,
    );
  }
  return changed;
}
