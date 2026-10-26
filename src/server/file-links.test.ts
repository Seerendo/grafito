import assert from "node:assert/strict";
import { test } from "node:test";
import { signedFileUrl, verifyFileUrl } from "./file-links.ts";

/** Enlaces firmados a archivos: válidos, manipulados y caducados. */

process.env.BETTER_AUTH_SECRET = "secreto-de-pruebas-para-enlaces-firmados";

function params(url: string): URLSearchParams {
  return new URL(url, "http://grafito.test").searchParams;
}

test("un enlace firmado se verifica con su dueño y sin descarga", () => {
  const url = signedFileUrl("doc-1", "user-1");
  assert.deepEqual(verifyFileUrl("doc-1", params(url)), { ownerId: "user-1", download: false });
});

test("otro documento, otro dueño o activar la descarga invalidan la firma", () => {
  const url = signedFileUrl("doc-1", "user-1");
  assert.equal(verifyFileUrl("doc-2", params(url)), null);
  const owner = params(url);
  owner.set("o", "user-2");
  assert.equal(verifyFileUrl("doc-1", owner), null);
  const download = params(url);
  download.set("d", "1");
  assert.equal(verifyFileUrl("doc-1", download), null);
});

test("el enlace de descarga lleva su propio permiso", () => {
  const url = signedFileUrl("doc-1", "user-1", true);
  assert.deepEqual(verifyFileUrl("doc-1", params(url)), { ownerId: "user-1", download: true });
});

test("caducado: no vale", () => {
  const url = signedFileUrl("doc-1", "user-1");
  const expired = params(url);
  expired.set("e", String(Math.floor(Date.now() / 1000) - 10));
  assert.equal(verifyFileUrl("doc-1", expired), null);
});
