import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Secretos propios de cada instalación (solo servidor).
 *
 * `BETTER_AUTH_SECRET` firma las sesiones, los enlaces de archivos y las
 * fichas del editor de Office; `GRAFITO_ENCRYPTION_KEY` cifra las claves de IA
 * y la contraseña SMTP. Si faltan o tienen el valor de ejemplo que se publicó
 * en `docker-compose.yml` (y que cualquiera puede leer en el repositorio), con
 * él se podrían falsificar enlaces y fichas para leer o cambiar archivos ajenos.
 *
 * En ese caso se usa uno aleatorio de esta instalación, guardado en
 * `GRAFITO_SECRETS_DIR` (por defecto `.data/secrets`; en Docker, su propio
 * volumen). No va en la base de datos para que una copia de la base no lleve
 * también la clave que descifra lo que contiene. La clave de cifrado de
 * ejemplo pasa a `GRAFITO_ENCRYPTION_KEY_PREVIOUS` (si no hay otra), así lo
 * cifrado con ella en versiones anteriores se sigue leyendo y se vuelve a
 * cifrar con la nueva al usarse.
 */

/** Valores de ejemplo publicados: nunca valen como secreto. */
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
    /* sistemas sin permisos POSIX */
  }
  return value;
}

/** Pone en el entorno secretos propios donde falten o sean los de ejemplo. Una vez por proceso. */
export function ensureInstallSecrets(): void {
  if (done) return;
  done = true;
  installSecrets(process.env, secretsDir());
}

/** Lo de `ensureInstallSecrets` sobre un entorno y una carpeta dados; devuelve qué cambió. */
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
      // Sin disco donde guardarlo (p. ej. una plataforma sin sistema de
      // archivos): uno por proceso, mejor que el público.
      value = randomBytes(48).toString("base64url");
      console.error(`[grafito] No se pudo guardar ${name} en ${dir}:`, error);
    }
    // Lo cifrado hasta ahora pudo hacerse con la clave de ejemplo (la pasaba
    // `docker-compose.yml`, aunque hoy llegue vacía): se sigue pudiendo leer.
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
