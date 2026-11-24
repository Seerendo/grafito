import assert from "node:assert/strict";
import { test } from "node:test";
import { internalHostReason } from "../../src/server/internal-host.ts";

test("servicios de Compose y enlace local se rechazan (GRAF-15, GRAF-17)", () => {
  for (const host of [
    "postgres",
    "grafeno",
    "collabora",
    "clamav",
    "latex",
    "gateway",
    "backup",
    "169.254.169.254",
    "[::ffff:169.254.169.254]",
    "[fe80::1]",
  ])
    assert.ok(internalHostReason(host), host);
});

test("la red local, internet y los proveedores permitidos se aceptan", () => {
  for (const host of ["192.168.1.20", "10.0.0.5", "sso.example.com", "localhost"])
    assert.equal(internalHostReason(host), null, host);
  assert.equal(internalHostReason("keycloak", ["keycloak", "openldap"]), null);
  assert.ok(internalHostReason("keycloak"));
});
