import assert from "node:assert/strict";
import test from "node:test";
import { canSwitch, extensionActive, extensionPhase } from "../../src/domain/extensions.ts";

/** Extensions: a service that does not answer pauses the extension and blocks turning it on. */

const up = { ok: true, service: true };
const down = { ok: false, service: true };
const local = { ok: true, service: false };

test("una extensión sin servicio va como la elija el administrador", () => {
  assert.equal(extensionPhase(true, local), "local");
  assert.equal(extensionActive(true, local), true);
  assert.equal(extensionActive(false, local), false);
  assert.equal(canSwitch(false, local), true);
});

test("con su servicio respondiendo se activa y se usa", () => {
  assert.equal(extensionPhase(false, up), "connected");
  assert.equal(canSwitch(false, up), true);
  assert.equal(extensionActive(true, up), true);
});

test("sin conexión no se puede activar", () => {
  assert.equal(extensionPhase(false, down), "offline");
  assert.equal(canSwitch(false, down), false);
});

test("activa y sin conexión queda en pausa, se puede apagar y vuelve sola", () => {
  assert.equal(extensionPhase(true, down), "paused");
  assert.equal(extensionActive(true, down), false);
  assert.equal(canSwitch(true, down), true);
  assert.equal(extensionActive(true, up), true);
});
