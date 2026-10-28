import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installSecrets } from "./install-secrets.ts";

/** Secretos propios de la instalación en vez de los de ejemplo públicos. */

const dir = () => mkdtempSync(join(tmpdir(), "grafito-secrets-"));

test("los valores de ejemplo publicados se sustituyen; la clave vieja pasa a ser la anterior", () => {
  const folder = dir();
  const env: Record<string, string | undefined> = {
    BETTER_AUTH_SECRET: "grafito-dev-secret-cambia-esto",
    GRAFITO_ENCRYPTION_KEY: "grafito-dev-encryption-key-cambia-esto-0001",
  };
  assert.deepEqual(installSecrets(env, folder), ["BETTER_AUTH_SECRET", "GRAFITO_ENCRYPTION_KEY"]);
  assert.notEqual(env.BETTER_AUTH_SECRET, "grafito-dev-secret-cambia-esto");
  assert.ok(env.BETTER_AUTH_SECRET!.length >= 32);
  assert.equal(env.GRAFITO_ENCRYPTION_KEY_PREVIOUS, "grafito-dev-encryption-key-cambia-esto-0001");
  assert.equal(readFileSync(join(folder, "BETTER_AUTH_SECRET"), "utf8").trim(), env.BETTER_AUTH_SECRET);
  rmSync(folder, { recursive: true });
});

test("sin valor se crea uno, y el mismo en el siguiente arranque", () => {
  const folder = dir();
  const first: Record<string, string | undefined> = {};
  installSecrets(first, folder);
  const second: Record<string, string | undefined> = {};
  installSecrets(second, folder);
  assert.equal(second.BETTER_AUTH_SECRET, first.BETTER_AUTH_SECRET);
  assert.equal(second.GRAFITO_ENCRYPTION_KEY, first.GRAFITO_ENCRYPTION_KEY);
  // Las versiones anteriores cifraban con la clave de ejemplo: se sigue pudiendo leer.
  assert.equal(first.GRAFITO_ENCRYPTION_KEY_PREVIOUS, "grafito-dev-encryption-key-cambia-esto-0001");
  rmSync(folder, { recursive: true });
});

test("un secreto propio no se toca", () => {
  const folder = dir();
  const env: Record<string, string | undefined> = {
    BETTER_AUTH_SECRET: "un-secreto-propio-largo-de-verdad-0123456789",
    GRAFITO_ENCRYPTION_KEY: "otra-clave-propia-larga-de-verdad-0123456789",
  };
  assert.deepEqual(installSecrets(env, folder), []);
  assert.equal(env.BETTER_AUTH_SECRET, "un-secreto-propio-largo-de-verdad-0123456789");
  rmSync(folder, { recursive: true });
});

test("al actualizar sin clave en .env, lo cifrado con la de ejemplo se sigue leyendo", async () => {
  const { encrypt, open } = await import("./crypto.ts");
  const folder = dir();
  const saved = { ...process.env };
  try {
    process.env.GRAFITO_ENCRYPTION_KEY = "grafito-dev-encryption-key-cambia-esto-0001";
    const sealed = encrypt("clave-de-ia");
    delete process.env.GRAFITO_ENCRYPTION_KEY;
    delete process.env.GRAFITO_ENCRYPTION_KEY_PREVIOUS;
    installSecrets(process.env, folder);
    assert.deepEqual(open(sealed), { value: "clave-de-ia", stale: true });
    assert.equal(open(encrypt("nueva")).stale, false);
  } finally {
    for (const key of ["BETTER_AUTH_SECRET", "GRAFITO_ENCRYPTION_KEY", "GRAFITO_ENCRYPTION_KEY_PREVIOUS"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(folder, { recursive: true });
  }
});
