import assert from "node:assert/strict";
import { test } from "node:test";
import { auditToCsv, auditToJson, clampRetentionDays } from "./audit-export.ts";

const row = {
  at: "2026-11-02T00:00:00.000Z",
  actor: "Ada",
  action: "upload",
  outcome: "ok",
  area: "archivos",
  target: "informe.pdf",
  detail: 'dice "hola", y sigue',
  ip: "127.0.0.1",
};

test("la retención solo acepta días enteros entre 7 y 3650", () => {
  assert.equal(clampRetentionDays(365), 365);
  assert.equal(clampRetentionDays(7), 7);
  assert.equal(clampRetentionDays(6), null);
  assert.equal(clampRetentionDays(3651), null);
  assert.equal(clampRetentionDays(3.5), null);
});

test("el CSV escapa comillas y comas, y lleva BOM", () => {
  const csv = auditToCsv([row]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('"dice ""hola"", y sigue"'));
  assert.equal(auditToCsv([]).includes("at,actor,action"), true);
});

test("el JSON conserva el texto", () => {
  const parsed = JSON.parse(auditToJson([row])) as { detail: string }[];
  assert.equal(parsed[0]?.detail, row.detail);
});
