import assert from "node:assert/strict";
import { test } from "node:test";
import { pagePlainText } from "../../../src/domain/vault/pdf-text.ts";

/** Page text shared by the viewer and the PDF phrase link. */

test("une los fragmentos y marca el fin de línea", () => {
  assert.equal(
    pagePlainText([
      { str: "Hola" },
      { str: " mundo", hasEOL: true },
      { str: "adiós" },
      { hasEOL: true },
      null,
      "no",
    ]),
    "Hola mundo\nadiós",
  );
});
