import assert from "node:assert/strict";
import test from "node:test";
import {
  PUSH_BYTES,
  PUSH_DELETES,
  PUSH_DOCS,
  pushBatches,
} from "../../../src/domain/vault/sync-batches.ts";
import type { Document } from "../../../src/domain/vault/types.ts";

/** How synchronization splits local changes into pushes. */

function note(id: string, length = 10): Document {
  return {
    id,
    title: id,
    kind: "markdown",
    portfolioId: null,
    content: "x".repeat(length),
    file: null,
    links: [],
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    createdBy: "a",
    updatedBy: "a",
  };
}

const none = { docs: [], deletedDocs: [], portfolios: [], deletedPortfolios: [] };

test("nada que enviar, ningún envío", () => {
  assert.deepEqual(pushBatches(none), []);
});

test("cada envío respeta el número de documentos y de bytes", () => {
  const docs = Array.from({ length: 250 }, (_, index) => note(`n${index}`));
  assert.deepEqual(
    pushBatches({ ...none, docs }).map((batch) => batch.docs.length),
    [PUSH_DOCS, PUSH_DOCS, 50],
  );
  const big = Array.from({ length: 30 }, (_, index) => note(`g${index}`, 300_000));
  for (const batch of pushBatches({ ...none, docs: big })) {
    const bytes = batch.docs.reduce((sum, doc) => sum + doc.content.length, 0);
    assert.ok(bytes <= PUSH_BYTES, `${bytes}`);
  }
  // A single note larger than the budget still goes, alone.
  assert.deepEqual(
    pushBatches({ ...none, docs: [note("enorme", 2_500_000), note("otra")] }).map((batch) =>
      batch.docs.map((doc) => doc.id),
    ),
    [["enorme"], ["otra"]],
  );
});

test("carpetas antes que documentos, y carpetas borradas antes que sus documentos", () => {
  const batches = pushBatches({
    docs: [note("d1")],
    deletedDocs: Array.from({ length: PUSH_DELETES + 5 }, (_, index) => `x${index}`),
    portfolios: [{ id: "p1", name: "P", parentId: null }],
    deletedPortfolios: ["q1"],
  });
  assert.equal(batches[0]?.portfolios[0]?.id, "p1");
  assert.equal(batches[0]?.docs[0]?.id, "d1");
  const order = batches.flatMap((batch) => [...batch.deletedPortfolios, ...batch.deletedDocs]);
  assert.equal(order[0], "q1");
  assert.equal(order.length, PUSH_DELETES + 6);
  for (const batch of batches)
    assert.ok(batch.deletedDocs.length + batch.deletedPortfolios.length <= PUSH_DELETES);
});
