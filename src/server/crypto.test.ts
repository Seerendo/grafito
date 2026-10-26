import assert from "node:assert/strict";
import { test } from "node:test";
import { decrypt, encrypt, EncryptionUnavailable, encryptionReady, open } from "./crypto.ts";

/** Cifrado de las claves de IA: ida y vuelta, aleatoriedad, integridad y clave ausente. */

const KEY = "una-clave-de-pruebas-suficientemente-larga-0123456789";

test("cifra y descifra; dos cifrados del mismo texto son distintos", () => {
  process.env.GRAFITO_ENCRYPTION_KEY = KEY;
  const a = encrypt("sk-secreta");
  const b = encrypt("sk-secreta");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("v1:"));
  assert.ok(!a.includes("sk-secreta"));
  assert.equal(decrypt(a), "sk-secreta");
});

test("detecta un cifrado manipulado", () => {
  process.env.GRAFITO_ENCRYPTION_KEY = KEY;
  const [version, iv, tag, data] = encrypt("sk-secreta").split(":");
  const flipped = Buffer.from(data!, "base64url");
  flipped[0] = flipped[0]! ^ 1;
  assert.throws(() => decrypt([version, iv, tag, flipped.toString("base64url")].join(":")));
});

test("con otra clave no se puede leer", () => {
  process.env.GRAFITO_ENCRYPTION_KEY = KEY;
  const sealed = encrypt("sk-secreta");
  process.env.GRAFITO_ENCRYPTION_KEY = `${KEY}-otra`;
  assert.throws(() => decrypt(sealed));
});

test("sin GRAFITO_ENCRYPTION_KEY (o demasiado corta) no cifra", () => {
  delete process.env.GRAFITO_ENCRYPTION_KEY;
  assert.equal(encryptionReady(), false);
  assert.throws(() => encrypt("x"), EncryptionUnavailable);
  process.env.GRAFITO_ENCRYPTION_KEY = "corta";
  assert.equal(encryptionReady(), false);
});

test("rotación: lo cifrado con la clave anterior se lee y avisa que hay que volver a cifrarlo", () => {
  process.env.GRAFITO_ENCRYPTION_KEY = KEY;
  const sealed = encrypt("sk-secreta");
  process.env.GRAFITO_ENCRYPTION_KEY = `${KEY}-nueva`;
  process.env.GRAFITO_ENCRYPTION_KEY_PREVIOUS = KEY;
  assert.deepEqual(open(sealed), { value: "sk-secreta", stale: true });
  assert.deepEqual(open(encrypt("sk-otra")), { value: "sk-otra", stale: false });
  delete process.env.GRAFITO_ENCRYPTION_KEY_PREVIOUS;
  assert.throws(() => open(sealed));
});
