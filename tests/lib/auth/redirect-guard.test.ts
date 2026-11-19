import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignRedirects, isLocalPath } from "../../../src/lib/auth/redirect-guard.ts";

/** Redirects after sign-in only to paths on this site (security finding GRAF-13). */

test("rutas locales sí; direcciones absolutas, de protocolo relativo o con barra invertida no", () => {
  for (const ok of ["/", "/login", "/admin?x=1"]) assert.equal(isLocalPath(ok), true, ok);
  for (const bad of [
    "https://otro.example/",
    "//otro.example",
    "/\\otro.example",
    "javascript:x",
    "",
    "/a\nb",
  ])
    assert.equal(isLocalPath(bad), false, bad);
});

test("se revisan la consulta y el cuerpo JSON", () => {
  assert.deepEqual(
    foreignRedirects(new URLSearchParams("callbackURL=/"), { callbackURL: "/" }),
    [],
  );
  assert.deepEqual(
    foreignRedirects(new URLSearchParams(), {
      provider: "google",
      callbackURL: "https://otro.example/",
      errorCallbackURL: "/login",
    }),
    ["callbackURL"],
  );
  assert.deepEqual(foreignRedirects(new URLSearchParams("callbackURL=//otro.example"), null), [
    "callbackURL",
  ]);
  assert.deepEqual(foreignRedirects(new URLSearchParams(), { redirectTo: 5 }), ["redirectTo"]);
});
