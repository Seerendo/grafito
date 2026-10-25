import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLocalUrl } from "./local-url.ts";

test("acepta instancias propias en la red o en internet", () => {
  assert.deepEqual(checkLocalUrl(" http://192.168.1.20:11434/ "), { ok: true, url: "http://192.168.1.20:11434" });
  assert.deepEqual(checkLocalUrl("http://host.docker.internal:1234/v1"), { ok: true, url: "http://host.docker.internal:1234/v1" });
  assert.deepEqual(checkLocalUrl("https://ollama.mi-dominio.com"), { ok: true, url: "https://ollama.mi-dominio.com" });
});

test("rechaza el propio servidor y los servicios internos", () => {
  for (const url of [
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://[::1]:11434",
    "http://0.0.0.0:11434",
    "http://postgres:5432",
    "http://redis:6379",
    "http://elasticsearch:9200",
    "http://minio:9000",
    "http://app:8080",
  ]) {
    assert.equal(checkLocalUrl(url).ok, false, url);
  }
});

test("rechaza otros esquemas, credenciales y texto que no es URL", () => {
  assert.equal(checkLocalUrl("file:///etc/passwd").ok, false);
  assert.equal(checkLocalUrl("ftp://equipo:21").ok, false);
  assert.equal(checkLocalUrl("http://usuario:clave@equipo:11434").ok, false);
  assert.equal(checkLocalUrl("no es una url").ok, false);
  assert.equal(checkLocalUrl("").ok, false);
});
