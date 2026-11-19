import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedMessage,
  extensionOf,
  indexBlocked,
  normalizeExtensions,
  parseRules,
  uploadBlocked,
} from "../../src/domain/file-extensions.ts";

/** Extension rules: upload blocks and index-only blocks. */

test("extensionOf: última extensión en minúsculas", () => {
  assert.equal(extensionOf("Copia.ISO"), "iso");
  assert.equal(extensionOf("datos/2024/backup.tar.gz"), "gz");
  assert.equal(extensionOf("C:\\dir\\a.Rar"), "rar");
  assert.equal(extensionOf("README"), "");
  assert.equal(extensionOf(".bashrc"), "");
  assert.equal(extensionOf("raro."), "");
});

test("normalizeExtensions: limpia lo que escribe la gente", () => {
  assert.deepEqual(normalizeExtensions(".RAR, iso; *.7z  torrent rar"), [
    "7z",
    "iso",
    "rar",
    "torrent",
  ]);
  assert.deepEqual(normalizeExtensions(["../x", "a b", "", "tar.gz"]), []);
});

test("bloqueo de subida e indexación por separado", () => {
  const rules = parseRules("rar,iso", "mp4");
  assert.equal(uploadBlocked("pelicula.RAR", rules), true);
  assert.equal(uploadBlocked("pelicula.mp4", rules), false);
  assert.equal(indexBlocked("pelicula.mp4", rules), true);
  assert.equal(indexBlocked("notas.md", rules), false);
  assert.equal(uploadBlocked("sin-extension", rules), false);
});

test("blockedMessage nombra la extensión y el archivo", () => {
  assert.equal(blockedMessage("disco.iso"), "No se permite subir archivos .iso («disco.iso»).");
});
