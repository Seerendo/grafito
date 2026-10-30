import assert from "node:assert/strict";
import { test } from "node:test";
import { signatureMaterial } from "./signature.ts";

test("una nota se identifica por su título y su texto", () => {
  assert.equal(
    signatureMaterial({ kind: "markdown", title: "Acta", content: "hoy", fileKey: "" }),
    "markdown\nActa\nhoy",
  );
});

test("un archivo se identifica por su clave, no por un texto vacío", () => {
  const first = signatureMaterial({ kind: "file", title: "Acta", content: "", fileKey: "vault/a/1" });
  const next = signatureMaterial({ kind: "file", title: "Acta", content: "", fileKey: "vault/a/2" });
  assert.notEqual(first, next);
  assert.match(first, /^file\nActa\nvault\/a\/1$/);
});
