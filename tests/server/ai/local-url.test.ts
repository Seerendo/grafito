import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLocalUrl } from "../../../src/server/ai/local-url.ts";

test("acepta instancias propias en la red o en internet", () => {
  assert.deepEqual(checkLocalUrl(" http://192.168.1.20:11434/ "), {
    ok: true,
    url: "http://192.168.1.20:11434",
    target: "http://192.168.1.20:11434",
  });
  assert.deepEqual(checkLocalUrl("http://host.docker.internal:1234/v1"), {
    ok: true,
    url: "http://host.docker.internal:1234/v1",
    target: "http://host.docker.internal:1234/v1",
  });
  assert.deepEqual(checkLocalUrl("https://ollama.mi-dominio.com"), {
    ok: true,
    url: "https://ollama.mi-dominio.com",
    target: "https://ollama.mi-dominio.com",
  });
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

test("con el alias de Docker, «localhost» llama al equipo anfitrión", () => {
  assert.deepEqual(checkLocalUrl("http://localhost:1235/v1", "host.docker.internal"), {
    ok: true,
    url: "http://localhost:1235/v1",
    target: "http://host.docker.internal:1235/v1",
  });
  assert.deepEqual(checkLocalUrl("http://127.0.0.1:11434", "host.docker.internal"), {
    ok: true,
    url: "http://127.0.0.1:11434",
    target: "http://host.docker.internal:11434",
  });
  // Reject aliases pointing to the app container or internal services.
  assert.equal(checkLocalUrl("http://localhost:11434", "localhost").ok, false);
  assert.equal(checkLocalUrl("http://localhost:11434", "postgres").ok, false);
  assert.equal(checkLocalUrl("http://postgres:5432", "host.docker.internal").ok, false);
});

test("servicios de Compose, enlace local y loopback IPv6 ya normalizado se rechazan (GRAF-15)", () => {
  for (const url of [
    "http://grafeno:7700",
    "http://collabora:9980",
    "http://clamav:3310",
    "http://gateway/",
    "http://backup/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]:11434",
    "http://[::ffff:7f00:1]/",
  ])
    assert.equal(checkLocalUrl(url).ok, false, url);
  assert.equal(checkLocalUrl("http://192.168.1.20:11434").ok, true);
  assert.equal(checkLocalUrl("http://10.0.0.5:1234/v1").ok, true);
});
