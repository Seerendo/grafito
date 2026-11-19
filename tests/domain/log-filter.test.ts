import assert from "node:assert/strict";
import { test } from "node:test";
import { filterInstant, likePattern } from "../../src/domain/log-filter.ts";

/** Log and audit filters. */

test("likePattern: busca en cualquier parte sin comodines del usuario", () => {
  assert.equal(likePattern("  ana "), "%ana%");
  assert.equal(likePattern("50%_a\\b"), "%50ab%");
});

test("filterInstant: ISO o vacío", () => {
  assert.equal(filterInstant("2026-11-18T10:30:00.000Z"), "2026-11-18T10:30:00.000Z");
  assert.equal(filterInstant(""), "");
  assert.equal(filterInstant(undefined), "");
  assert.equal(filterInstant("no es fecha"), "");
});
