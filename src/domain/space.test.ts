import assert from "node:assert/strict";
import { test } from "node:test";
import { checkShares, formatBytes } from "./space.ts";

/** El reparto de un portafolio y el formato de tamaños (sin base de datos). */


test("formato de tamaños", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(512), "1 KB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5 MB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2 GB");
  assert.equal(formatBytes(1.5 * 1024 ** 3), "1.5 GB");
});

test("el reparto no pasa del portafolio", () => {
  const MB = 1024 ** 2;
  assert.equal(checkShares(null, new Map([["a", 999 * MB]])), null);
  assert.equal(checkShares(100 * MB, new Map([["a", 40 * MB], ["b", 60 * MB]])), null);
  assert.match(checkShares(100 * MB, new Map([["a", 120 * MB]])) ?? "", /más que el portafolio/);
  assert.match(checkShares(100 * MB, new Map([["a", 60 * MB], ["b", 60 * MB]])) ?? "", /pasa del espacio/);
});
