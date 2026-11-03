import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleView,
  canReadShare,
  canWriteOwn,
  canWriteShare,
  createRefusal,
  matchDocs,
  matchFolders,
  takeVisible,
  writeRefusal,
  type AiDoc,
  type ShareSlice,
  type VaultCaps,
} from "./access.ts";

/**
 * El asistente no abre la bóveda de otro ni escribe donde solo hay lectura.
 * Estas reglas no dependen del modelo: un id ajeno no está, y un documento
 * de solo lectura se rechaza antes de guardar.
 */

const FULL: VaultCaps = {
  readOnly: false,
  editNotes: true,
  createNotes: true,
  managePortfolios: true,
};
const READ_ROLE: VaultCaps = {
  readOnly: false,
  editNotes: false,
  createNotes: false,
  managePortfolios: false,
};
const PROFILE_RO: VaultCaps = {
  readOnly: true,
  editNotes: true,
  createNotes: true,
  managePortfolios: true,
};

function doc(partial: Partial<AiDoc> & Pick<AiDoc, "id" | "title">): AiDoc {
  return {
    ownerId: "me",
    shareId: null,
    kind: "markdown",
    portfolioId: null,
    place: "Carpeta Personal",
    source: "propio",
    access: "edición",
    fileName: null,
    ...partial,
  };
}

test("un compartido normal se lee entero y solo se escribe con edición o administración", () => {
  for (const access of ["read", "edit", "admin"] as const) {
    assert.equal(canReadShare({ access }, "p1"), true);
  }
  assert.equal(canWriteShare({ access: "read" }, "p1"), false);
  assert.equal(canWriteShare({ access: "edit" }, "p1"), true);
  assert.equal(canWriteShare({ access: "admin" }, null), true);
});

test("en un espacio la concesión de la carpeta decide, no el rol", () => {
  const facts = {
    access: "read" as const,
    workspace: true,
    folderAccess: { informes: "read" as const, ventas: "edit" as const },
  };
  assert.equal(canReadShare(facts, "informes"), true);
  assert.equal(canWriteShare(facts, "informes"), false);
  assert.equal(canReadShare(facts, "ventas"), true);
  assert.equal(canWriteShare(facts, "ventas"), true);
  // Carpeta del camino, sin concesión: ni sus documentos ni se escribe en ella.
  assert.equal(canReadShare(facts, "raiz"), false);
  assert.equal(canWriteShare(facts, "raiz"), false);
  assert.equal(canWriteShare(facts, null), false);
  assert.equal(canReadShare({ access: "read", workspace: true }, "informes"), false);
  assert.equal(canWriteShare({ access: "edit", workspace: true }, "informes"), true);
  assert.equal(canWriteShare({ access: "admin", workspace: true }, "raiz"), true);
});

test("la bóveda propia se edita solo con el permiso y sin perfil de solo lectura", () => {
  assert.equal(canWriteOwn(true, false), true);
  assert.equal(canWriteOwn(false, false), false);
  assert.equal(canWriteOwn(true, true), false);
});

test("armar la vista deja fuera lo no concedido y marca la lectura", () => {
  const space: ShareSlice = {
    shareId: "s1",
    ownerId: "ana",
    ownerName: "Ana",
    title: "Ventas",
    access: "read",
    workspace: true,
    folderAccess: { informes: "read", borradores: "edit" },
    portfolios: [
      { id: "raiz", name: "Ventas", parentId: null },
      { id: "informes", name: "Informes", parentId: "raiz" },
      { id: "borradores", name: "Borradores", parentId: "raiz" },
    ],
    documents: [
      {
        id: "visible",
        title: "Informe mayo",
        kind: "markdown",
        portfolioId: "informes",
        fileName: null,
      },
      {
        id: "editable",
        title: "Borrador",
        kind: "markdown",
        portfolioId: "borradores",
        fileName: null,
      },
      { id: "oculto", title: "Nóminas", kind: "markdown", portfolioId: "raiz", fileName: null },
      {
        id: "ajeno",
        title: "Privado de Ana",
        kind: "markdown",
        portfolioId: "otra",
        fileName: null,
      },
    ],
  };
  const view = assembleView({
    userId: "me",
    caps: FULL,
    ownPortfolios: [{ id: "atlas", name: "Atlas", parentId: null }],
    ownDocs: [
      { id: "mia", title: "Notas propias", kind: "markdown", portfolioId: "atlas", fileName: null },
    ],
    shares: [space],
  });
  const ids = view.docs.map((item) => item.id).sort();
  assert.deepEqual(ids, ["editable", "mia", "visible"]);
  const visible = view.docs.find((item) => item.id === "visible")!;
  assert.equal(visible.access, "lectura");
  assert.equal(visible.source, "espacio");
  assert.equal(visible.place, "Espacio · Ventas · Ventas › Informes");
  assert.equal(
    writeRefusal(visible),
    "Puedes ver «Informe mayo» (Espacio · Ventas · Ventas › Informes) pero no editarlo.",
  );
  const editable = view.docs.find((item) => item.id === "editable")!;
  assert.equal(editable.access, "edición");
  assert.equal(writeRefusal(editable), null);
  const informes = view.folders.find((folder) => folder.id === "informes")!;
  assert.equal(informes.access, "lectura");
  assert.ok(createRefusal(informes));
  const borradores = view.folders.find((folder) => folder.id === "borradores")!;
  assert.equal(borradores.access, "edición");
  assert.equal(createRefusal(borradores), null);
  assert.equal(view.docs.find((item) => item.id === "mia")!.place, "Atlas");
});

test("un compartido de solo lectura no se edita; uno de edición sí", () => {
  const share = (access: "read" | "edit"): ShareSlice => ({
    shareId: "s",
    ownerId: "ana",
    ownerName: "Ana",
    title: "Actas",
    access,
    workspace: false,
    portfolios: [{ id: "actas", name: "Actas", parentId: null }],
    documents: [
      { id: "acta", title: "Acta 1", kind: "file", portfolioId: "actas", fileName: "acta.pdf" },
    ],
  });
  const read = assembleView({
    userId: "me",
    caps: FULL,
    ownPortfolios: [],
    ownDocs: [],
    shares: [share("read")],
  });
  assert.equal(read.docs[0]!.access, "lectura");
  assert.equal(read.docs[0]!.source, "compartido");
  assert.equal(read.docs[0]!.place, "Compartido · Ana · Actas");
  const edit = assembleView({
    userId: "me",
    caps: FULL,
    ownPortfolios: [],
    ownDocs: [],
    shares: [share("edit")],
  });
  assert.equal(edit.docs[0]!.access, "edición");
});

test("sin permiso de edición, o con perfil de solo lectura, lo propio queda en lectura", () => {
  const own = {
    userId: "me",
    ownPortfolios: [],
    ownDocs: [
      { id: "mia", title: "Notas", kind: "markdown" as const, portfolioId: null, fileName: null },
    ],
    shares: [],
  };
  assert.equal(assembleView({ ...own, caps: READ_ROLE }).docs[0]!.access, "lectura");
  assert.equal(assembleView({ ...own, caps: PROFILE_RO }).docs[0]!.access, "lectura");
  assert.equal(assembleView({ ...own, caps: PROFILE_RO }).folders[0]!.access, "lectura");
});

test("si el mismo documento llega por dos vías, se queda la que permite editar", () => {
  const base = {
    ownerId: "ana",
    ownerName: "Ana",
    title: "Ventas",
    workspace: true,
    portfolios: [{ id: "f", name: "Informes", parentId: null }],
    documents: [
      { id: "d", title: "Informe", kind: "markdown" as const, portfolioId: "f", fileName: null },
    ],
  };
  const view = assembleView({
    userId: "me",
    caps: FULL,
    ownPortfolios: [],
    ownDocs: [],
    shares: [
      { ...base, shareId: "solo", access: "read", folderAccess: { f: "read" } },
      { ...base, shareId: "puede", access: "read", folderAccess: { f: "edit" } },
    ],
  });
  assert.equal(view.docs.length, 1);
  assert.equal(view.docs[0]!.access, "edición");
  assert.equal(view.docs[0]!.shareId, "puede");
});

test("un id que no está no se confunde con un título, y los títulos repetidos no eligen solos", () => {
  const docs = [
    doc({ id: "a1", title: "Acta" }),
    doc({
      id: "b2",
      title: "Acta",
      shareId: "s",
      ownerId: "ana",
      source: "compartido",
      place: "Compartido · Ana",
    }),
    doc({ id: "c3", title: "Cierre anual" }),
  ];
  assert.equal(matchDocs(docs, "c3").status, "one");
  assert.equal(matchDocs(docs, "no-existe").status, "none");
  // El id tiene que coincidir entero: un prefijo no abre otro documento.
  assert.equal(matchDocs(docs, "a1extra").status, "none");
  const same = matchDocs(docs, "Acta");
  assert.equal(same.status, "choices");
  if (same.status === "choices") assert.equal(same.docs.length, 2);
  const partial = matchDocs(docs, "cierre");
  assert.equal(partial.status, "one");
  if (partial.status === "one") assert.equal(partial.doc.id, "c3");
  assert.equal(matchDocs(docs, "[[Cierre anual]]").status, "one");
});

test("la raíz propia no se confunde con una carpeta de un espacio que se llama igual", () => {
  const view = assembleView({
    userId: "me",
    caps: FULL,
    ownPortfolios: [{ id: "atlas", name: "Atlas", parentId: null }],
    ownDocs: [],
    shares: [
      {
        shareId: "s",
        ownerId: "ana",
        ownerName: "Ana",
        title: "Ventas",
        access: "edit",
        workspace: true,
        portfolios: [{ id: "atlas-ajeno", name: "Atlas", parentId: null }],
        documents: [],
      },
    ],
  });
  const root = matchFolders(view.folders, "carpeta personal");
  assert.equal(root.status, "one");
  if (root.status === "one") assert.equal(root.folder.id, null);
  const ambiguous = matchFolders(view.folders, "Atlas");
  assert.equal(ambiguous.status, "choices");
  const byPath = matchFolders(view.folders, "Espacio · Ventas · Atlas");
  assert.equal(byPath.status, "one");
  if (byPath.status === "one") assert.equal(byPath.folder.id, "atlas-ajeno");
});

test("la búsqueda en la bóveda de otra persona solo devuelve lo visible", () => {
  const visible = [
    doc({ id: "visible", title: "Informe", ownerId: "ana", shareId: "s" }),
    doc({ id: "mio", title: "Mío", ownerId: "me" }),
  ];
  const hits = takeVisible(
    [{ id: "visible" }, { id: "nomina" }, { id: "mio" }, { id: "visible" }],
    visible,
    "ana",
  );
  assert.deepEqual(
    hits.map((item) => item.id),
    ["visible"],
  );
});
