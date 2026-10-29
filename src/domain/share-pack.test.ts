import assert from "node:assert/strict";
import { test } from "node:test";
import { packBody, unpackTree } from "./share-pack.ts";
import { descendantIds } from "./vault/portfolios.ts";

/** Cómo viaja el árbol de lo compartido, y el recorrido de portafolios. */

const share = { id: "s", kind: "portfolio" as const, title: "Equipo", ownerName: "Equipo", visibility: "shared" as const, access: "edit" as const };

test("empaquetar y desempaquetar deja el mismo árbol", () => {
  const portfolios = [
    { id: "raiz", name: "Equipo", parentId: null },
    { id: "a", name: "Actas", parentId: "raiz" },
  ];
  const documents = [
    {
      id: "n1",
      title: "Acta 1",
      kind: "markdown" as const,
      portfolioId: "a",
      content: "",
      lazy: true,
      wikiLinks: ["Acta 2"],
      file: null,
      updatedBy: "Ana",
      updatedAt: "2026-10-29T10:00:00.000Z",
      links: [{ targetId: "f1", kind: "referencia" as const }],
    },
    {
      id: "f1",
      title: "Plano.pdf",
      kind: "file" as const,
      portfolioId: "raiz",
      content: "",
      lazy: true,
      wikiLinks: [],
      file: { name: "Plano.pdf", mime: "application/pdf", url: "/api/files/f1", downloadUrl: null },
      updatedBy: "Luis",
      updatedAt: "2026-10-29T11:00:00.000Z",
      links: [],
    },
  ];
  const tree = unpackTree({ share, body: packBody(portfolios, documents) });
  assert.deepEqual(tree.portfolios, portfolios);
  assert.deepEqual(tree.documents, documents);
});

test("con el texto incluido no queda pendiente de pedir", () => {
  const tree = unpackTree({
    share,
    body: packBody(
      [],
      [
        {
          id: "n",
          title: "Nota",
          kind: "markdown",
          portfolioId: null,
          content: "# Hola",
          file: null,
          updatedBy: "",
          updatedAt: "2026-10-29T10:00:00.000Z",
        },
      ],
    ),
  });
  assert.equal(tree.documents[0]?.content, "# Hola");
  assert.equal(tree.documents[0]?.lazy, undefined);
});

test("los descendientes se encuentran aunque haya muchos niveles y estén desordenados", () => {
  // Una cadena de 5000 niveles, del más profundo al primero.
  const chain = Array.from({ length: 5000 }, (_, index) => ({ id: `p${index}`, parentId: index === 0 ? null : `p${index - 1}` })).reverse();
  const started = performance.now();
  const ids = descendantIds(chain, "p0");
  assert.equal(ids.size, 5000);
  assert.ok(performance.now() - started < 200, "debe ser lineal");
  assert.deepEqual([...descendantIds(chain, "p4998")].sort(), ["p4998", "p4999"]);
});

test("un ciclo en los datos no lo cuelga", () => {
  const loop = [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
  ];
  assert.deepEqual([...descendantIds(loop, "a")].sort(), ["a", "b"]);
});
