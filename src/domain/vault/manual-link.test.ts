import assert from "node:assert/strict";
import { test } from "node:test";
import { linkKept } from "../share.ts";
import { MAX_MANUAL_LINKS, withManualLink, withoutManualLink } from "./manual-link.ts";
import type { ManualLink } from "./types.ts";

const covered = { documentIds: new Set(["nota", "pdf"]), portfolioIds: new Set(["carpeta"]) };

test("un vínculo se queda si su destino está en lo compartido", () => {
  assert.equal(linkKept({ targetId: "nota" }, covered), true);
  assert.equal(linkKept({ targetId: "fuera" }, covered), false);
  assert.equal(linkKept({ targetId: "carpeta", target: "portfolio" }, covered), true);
  assert.equal(linkKept({ targetId: "nota", target: "portfolio" }, covered), false);
});

test("vincular sustituye el mismo destino y respeta el tope", () => {
  const first: ManualLink = { targetId: "nota", kind: "referencia" };
  const again: ManualLink = { targetId: "nota", kind: "llama" };
  const links = withManualLink([first], again);
  assert.ok(links !== "full");
  if (links === "full") return;
  assert.equal(links.length, 1);
  assert.equal(links[0]?.kind, "llama");
  const many = Array.from({ length: MAX_MANUAL_LINKS }, (_, index) => ({ targetId: `d${index}`, kind: "referencia" as const }));
  assert.equal(withManualLink(many, { targetId: "nueva", kind: "referencia" }), "full");
  const replaced = withManualLink(many, { targetId: "d0", kind: "llama" });
  assert.ok(replaced !== "full");
});

test("quitar un vínculo solo borra ese destino", () => {
  const links: ManualLink[] = [
    { targetId: "nota", kind: "referencia" },
    { targetId: "pdf", kind: "llama", anchor: { page: 1, exact: "EXP", prefix: "", suffix: "" } },
  ];
  const left = withoutManualLink(links, { targetId: "pdf", anchor: links[1]?.anchor });
  assert.deepEqual(left.map((link) => link.targetId), ["nota"]);
});
