import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installation code for the first administrator. Until an administrator exists, anyone who
 * reaches the address sees «Primera vez»; the code proves they can also read the server's log
 * or set its environment. GRAFITO_SETUP_CODE wins; otherwise a random code is kept in
 * GRAFITO_SECRETS_DIR and written to the log while setup is pending.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function secretsDir(): string {
  return process.env.GRAFITO_SECRETS_DIR?.trim() || join(process.cwd(), ".data", "secrets");
}

function generate(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

let cached: string | null = null;

export function setupCode(): string {
  const fromEnv = process.env.GRAFITO_SETUP_CODE?.trim();
  if (fromEnv) return fromEnv;
  if (cached) return cached;
  const file = join(secretsDir(), "SETUP_CODE");
  try {
    if (existsSync(file)) {
      const stored = readFileSync(file, "utf8").trim();
      if (stored.length >= 12) return (cached = stored);
    }
    mkdirSync(secretsDir(), { recursive: true });
    const value = generate();
    writeFileSync(file, `${value}\n`, { mode: 0o600 });
    return (cached = value);
  } catch {
    // Without a writable folder the code lives in this process only; the log still shows it.
    return (cached ??= generate());
  }
}

/** Case, spaces and dashes do not matter; the comparison takes the same time either way. */
export function sameSetupCode(given: string, expected: string): boolean {
  const clean = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = createHash("sha256").update(clean(given)).digest();
  const b = createHash("sha256").update(clean(expected)).digest();
  return clean(given).length > 0 && timingSafeEqual(a, b);
}

let announced = false;

/** Write the code to the log once per process while no administrator exists. */
export function announceSetupCode(): void {
  if (announced) return;
  announced = true;
  if (process.env.GRAFITO_SETUP_CODE?.trim()) {
    console.info("[grafito] Para crear el administrador, usa el código de GRAFITO_SETUP_CODE.");
    return;
  }
  console.info(`[grafito] Código de instalación para crear el administrador: ${setupCode()}`);
}
