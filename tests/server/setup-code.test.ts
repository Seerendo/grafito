import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/** Installation code for the first administrator (security finding GRAF-01). */

const dir = mkdtempSync(join(tmpdir(), "grafito-setup-"));
process.env.GRAFITO_SECRETS_DIR = dir;
delete process.env.GRAFITO_SETUP_CODE;
const { sameSetupCode, setupCode } = await import("../../src/server/setup-code.ts");

test("se genera una vez, legible, y se guarda en la carpeta de secretos", () => {
  const code = setupCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(setupCode(), code);
  assert.equal(readFileSync(join(dir, "SETUP_CODE"), "utf8").trim(), code);
});

test("mayúsculas, espacios y guiones no cuentan; otro código o vacío no vale", () => {
  assert.equal(sameSetupCode("abcd efgh-jkmn", "ABCD-EFGH-JKMN"), true);
  assert.equal(sameSetupCode("ABCD-EFGH-JKMP", "ABCD-EFGH-JKMN"), false);
  assert.equal(sameSetupCode("", "ABCD-EFGH-JKMN"), false);
  assert.equal(sameSetupCode("---", ""), false);
});

test("GRAFITO_SETUP_CODE manda sobre el archivo", () => {
  process.env.GRAFITO_SETUP_CODE = "codigo-propio";
  try {
    assert.equal(setupCode(), "codigo-propio");
  } finally {
    delete process.env.GRAFITO_SETUP_CODE;
  }
});
