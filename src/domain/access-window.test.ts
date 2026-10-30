import assert from "node:assert/strict";
import test from "node:test";
import { expiryAt } from "./access-window.ts";

const now = Date.UTC(2026, 9, 29, 12, 0, 0);

test("sin caducidad no pone fecha", () => {
  assert.equal(expiryAt("never", "", now), null);
});

test("los plazos cuentan desde ahora", () => {
  assert.equal(expiryAt("1", "", now), now + 86_400_000);
  assert.equal(expiryAt("7", "", now), now + 7 * 86_400_000);
  assert.equal(expiryAt("30", "", now), now + 30 * 86_400_000);
  assert.equal(expiryAt("90", "", now), now + 90 * 86_400_000);
});

test("una fecha caduca al final de ese día", () => {
  assert.equal(expiryAt("date", "2026-11-02", now), Date.UTC(2026, 10, 2, 23, 59, 59, 999));
  assert.equal(expiryAt("date", "02-11-2026", now), null);
});
