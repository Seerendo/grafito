import assert from "node:assert/strict";
import { test } from "node:test";
import { expandTo, landingAfterDelete, portfolioPath, sharedExpandKeys } from "./nav.ts";

const folders = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
];

test("la ruta de una carpeta sube hasta la raíz", () => {
  assert.deepEqual(portfolioPath(folders, "c"), ["c", "b", "a"]);
  assert.deepEqual(portfolioPath(folders, null), []);
});

test("desplegar una carpeta abre también a sus padres", () => {
  assert.deepEqual(expandTo({ a: true, b: true, c: true }, folders, "c"), { a: false, b: false, c: false });
  const open = { a: false };
  assert.equal(expandTo(open, folders, "a"), open);
});

test("borrar el documento que se está viendo abre su carpeta, no otro documento", () => {
  const landed = landingAfterDelete({
    activeId: "nota",
    folderPicked: false,
    selectedPortfolioId: "c",
    removedDocs: new Set(["nota"]),
    removedPortfolios: new Set(),
    activeDocPortfolioId: "c",
    portfolios: folders,
  });
  assert.deepEqual(landed, { activeId: null, selectedPortfolioId: "c", folderPicked: true, rootPicked: false });
});

test("borrar el documento de la raíz vuelve a la Carpeta Personal", () => {
  const landed = landingAfterDelete({
    activeId: "nota",
    folderPicked: false,
    selectedPortfolioId: null,
    removedDocs: new Set(["nota"]),
    removedPortfolios: new Set(),
    activeDocPortfolioId: null,
    portfolios: folders,
  });
  assert.deepEqual(landed, { activeId: null, selectedPortfolioId: null, folderPicked: false, rootPicked: true });
});

test("borrar otra cosa no cambia lo que se está viendo", () => {
  assert.equal(
    landingAfterDelete({
      activeId: "otra",
      folderPicked: false,
      selectedPortfolioId: "a",
      removedDocs: new Set(["nota"]),
      removedPortfolios: new Set(),
      activeDocPortfolioId: "a",
      portfolios: folders,
    }),
    null,
  );
});

test("si la carpeta del documento también se borra, se abre el padre que queda", () => {
  const landed = landingAfterDelete({
    activeId: "nota",
    folderPicked: false,
    selectedPortfolioId: "c",
    removedDocs: new Set(["nota"]),
    removedPortfolios: new Set(["c", "b"]),
    activeDocPortfolioId: "c",
    portfolios: folders,
  });
  assert.equal(landed?.selectedPortfolioId, "a");
});

test("lo compartido despliega el elemento y las carpetas de dentro, no la raíz otra vez", () => {
  assert.deepEqual(
    sharedExpandKeys({ shareId: "s", portfolios: folders, rootId: "a", portfolioId: "c" }),
    ["s", "s:c", "s:b"],
  );
  assert.deepEqual(sharedExpandKeys({ shareId: "s", portfolios: folders, rootId: "a", portfolioId: "a" }), ["s"]);
});
