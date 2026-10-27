import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestorsAllow, editorOrigin, officeProblem } from "./office-reach.ts";

/** Llegar al editor de Office desde otros equipos y por HTTPS. */

test("el editor se pide a la dirección del servidor si COLLABORA_URL quedó en 127.0.0.1", () => {
  assert.equal(editorOrigin("http://127.0.0.1:9980", "http://192.168.1.20:8080"), "http://192.168.1.20:9980");
  assert.equal(editorOrigin("http://localhost:9980", "http://notas.local:8080"), "http://notas.local:9980");
  assert.equal(editorOrigin("http://127.0.0.1:9980", "http://127.0.0.1:8080"), "http://127.0.0.1:9980");
  assert.equal(editorOrigin("https://office.ejemplo.com", "https://notas.ejemplo.com"), "https://office.ejemplo.com");
});

test("frame-ancestors: host, puerto, comodines y esquema", () => {
  assert.ok(ancestorsAllow("localhost:*", "http://localhost:3100"));
  assert.ok(ancestorsAllow("localhost:*", "http://127.0.0.1:8080"));
  assert.ok(!ancestorsAllow("localhost:*", "http://192.168.1.20:8080"));
  assert.ok(ancestorsAllow("192.168.1.20:8080", "http://192.168.1.20:8080"));
  assert.ok(!ancestorsAllow("192.168.1.20:8080", "http://192.168.1.20:9000"));
  assert.ok(ancestorsAllow("notas.ejemplo.com", "https://notas.ejemplo.com"));
  assert.ok(ancestorsAllow("https://notas.ejemplo.com", "https://notas.ejemplo.com"));
  assert.ok(!ancestorsAllow("http://notas.ejemplo.com", "https://notas.ejemplo.com"));
  assert.ok(ancestorsAllow("*.ejemplo.com", "https://notas.ejemplo.com"));
  assert.ok(ancestorsAllow("localhost:* notas.ejemplo.com", "https://notas.ejemplo.com"));
});

test("explica lo que el navegador bloqueará", () => {
  const base = { frameAncestors: "localhost:*", sslTermination: false };
  assert.equal(officeProblem({ ...base, collaboraUrl: "http://127.0.0.1:9980", pageOrigin: "http://127.0.0.1:8080" }), null);
  assert.match(
    officeProblem({ ...base, collaboraUrl: "http://127.0.0.1:9980", pageOrigin: "https://notas.ejemplo.com" }) ?? "",
    /HTTPS.*HTTP.*COLLABORA_SSL_TERMINATION=true/,
  );
  assert.match(
    officeProblem({ ...base, collaboraUrl: "https://office.ejemplo.com", pageOrigin: "https://notas.ejemplo.com" }) ?? "",
    /ws:\/\/.*COLLABORA_SSL_TERMINATION=true/,
  );
  assert.match(
    officeProblem({ ...base, collaboraUrl: "http://127.0.0.1:9980", pageOrigin: "http://192.168.1.20:8080" }) ?? "",
    /GRAFITO_PUBLIC_ORIGIN=192\.168\.1\.20:8080/,
  );
  assert.equal(
    officeProblem({
      frameAncestors: "notas.ejemplo.com",
      sslTermination: true,
      collaboraUrl: "https://office.ejemplo.com",
      pageOrigin: "https://notas.ejemplo.com",
    }),
    null,
  );
});

test("same-origin: el editor va en la dirección de la página, por http o por https", () => {
  assert.equal(editorOrigin("same-origin", "http://192.168.1.20:8080"), "http://192.168.1.20:8080");
  assert.equal(editorOrigin("same-origin", "https://notas.ejemplo.com/vault"), "https://notas.ejemplo.com");
  const base = { collaboraUrl: "same-origin", frameAncestors: "localhost:*", sslTermination: false };
  assert.equal(officeProblem({ ...base, pageOrigin: "https://notas.ejemplo.com" }), null);
  assert.equal(officeProblem({ ...base, pageOrigin: "http://192.168.1.20:8080" }), null);
});
