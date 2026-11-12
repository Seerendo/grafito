import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { Grafeno } from "@grafenodb/client";
import {
  ALL_EDGES,
  ANALYSIS_STEPS,
  READ_ANALYSIS,
  RELATED,
  analysisRows,
  relatedRows,
  docNode,
  docOps,
  edgeRows,
  portfolioOps,
  readIncoming,
  type GraphDoc,
} from "../../../src/server/graph/model.ts";

/**
 * The graph queries against a real engine (`grafeno serve --memory`). GRAFENO_BIN names the
 * binary, or GRAFENO_TEST_URL an engine already running; without either the test is skipped.
 */

const candidates = [
  process.env.GRAFENO_BIN,
  "C:/Program Files/Grafeno/grafeno.exe",
  "/usr/bin/grafeno",
  "/usr/local/bin/grafeno",
].filter((path): path is string => Boolean(path));
const binary = candidates.find((path) => existsSync(path));
const TOKEN = "grafito-test";

let child: ChildProcess | null = null;
let client: Grafeno | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

/** An engine already running (GRAFENO_TEST_URL, with GRAFENO_TEST_TOKEN) instead of a binary. */
const running = process.env.GRAFENO_TEST_URL;
const available = Boolean(running || binary);

before(async () => {
  if (running) {
    client = new Grafeno({ url: running, token: process.env.GRAFENO_TEST_TOKEN });
    return;
  }
  if (!binary) return;
  const port = await freePort();
  child = spawn(binary, ["serve", "--memory", "--addr", `127.0.0.1:${port}`, "--token", TOKEN], {
    stdio: "ignore",
  });
  client = new Grafeno({ url: `http://127.0.0.1:${port}`, token: TOKEN });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Grafeno did not start");
});

after(() => {
  child?.kill();
});

const doc = (id: string, title: string, content = "", links: GraphDoc["links"] = []): GraphDoc => ({
  id,
  title,
  kind: "markdown",
  content,
  links,
});

test("aristas, menciones y reemplazo en un Grafeno real", { skip: !available }, async () => {
  const ns = client!.namespace(`grafito-test-${Date.now()}`);
  await ns.batch([
    ...docOps(doc("a", "Alfa", "ver [[Beta]] y [[Plan]]", [{ targetId: "c", kind: "referencia" }])),
    ...docOps(doc("b", "Beta", "vuelve a [[alfa]]")),
    ...docOps(
      doc("c", "Gama", "", [
        { targetId: "a", kind: "llama", anchor: { exact: "frase", page: 2 } as never },
        { targetId: "s1", kind: "llama", shareId: "share" },
        { targetId: "p1", kind: "referencia", target: "portfolio" },
      ]),
    ),
    // A portfolio named like a wiki link does not take it.
    ...portfolioOps({ id: "p1", links: [{ targetId: "b", kind: "referencia" }] }),
  ]);

  const all = edgeRows((await ns.query(ALL_EDGES)).rows as unknown[][]);
  const pairs = all.map(
    (edge) => `${edge.kind}:${edge.from}>${edge.to}${edge.shareId ? `@${edge.shareId}` : ""}`,
  );
  assert.deepEqual(pairs.sort(), [
    "llama:c>a",
    "llama:c>s1@share",
    "referencia:a>c",
    "referencia:c>p1",
    "referencia:p1>b",
    "wiki:a>b",
    "wiki:b>a",
  ]);
  assert.equal(all.find((edge) => edge.to === "p1")?.target, "portfolio");

  // What points at a note, read through adjacency.
  const incoming = await readIncoming(ns, { id: "a", title: "Alfa" });
  assert.deepEqual(incoming.map((row) => [row.source, row.kind, Boolean(row.anchor)]).sort(), [
    ["b", "wiki", false],
    ["c", "llama", true],
  ]);
  // A title nobody holds and a portfolio without title answer empty, not with an error.
  assert.deepEqual(await readIncoming(ns, { id: "zzz", title: "Nadie" }), []);
  assert.deepEqual(
    (await readIncoming(ns, { id: "p1" })).map((row) => row.source),
    ["c"],
  );

  // Writing a note again replaces its links; deleting it removes them.
  await ns.batch(docOps(doc("a", "Alfa")));
  await ns.batch([{ op: "delete_node", id: docNode("b") }]);
  const left = edgeRows((await ns.query(ALL_EDGES)).rows as unknown[][]);
  assert.deepEqual(left.map((edge) => `${edge.from}>${edge.to}`).sort(), ["c>a", "c>p1", "c>s1"]);

  // A link to a title created later resolves without rewriting the linking note.
  await ns.batch(docOps(doc("d", "Delta", "ver [[Nuevo]]")));
  await ns.batch(docOps(doc("n", "Nuevo")));
  const later = edgeRows((await ns.query(ALL_EDGES)).rows as unknown[][]);
  assert.ok(later.some((edge) => edge.from === "d" && edge.to === "n" && edge.kind === "wiki"));
});

test("comunidades e importancia en un Grafeno real", { skip: !available }, async (t) => {
  const ns = client!.namespace(`grafito-analysis-${Date.now()}`);
  // Two tight groups joined by one link; "hub" is linked from every note of the first group
  // and links nowhere, so no single note inherits its whole score.
  const docs = [
    doc("hub", "Hub"),
    doc("a1", "A1", "[[Hub]] [[A2]]"),
    doc("a2", "A2", "[[Hub]] [[A1]]"),
    doc("a3", "A3", "[[Hub]] [[B1]]"),
    doc("b1", "B1", "[[B2]] [[B3]]"),
    doc("b2", "B2", "[[B1]] [[B3]]"),
    doc("b3", "B3", "[[B1]] [[B2]]"),
  ];
  await ns.batch(docs.flatMap(docOps));
  try {
    for (const step of ANALYSIS_STEPS) await ns.query(step);
  } catch (error) {
    // An engine before graph algorithms with write mode.
    t.skip(`motor sin algoritmos: ${(error as Error).message.slice(0, 80)}`);
    return;
  }
  const analysis = analysisRows((await ns.query(READ_ANALYSIS)).rows as unknown[][]);
  const of = (id: string) => analysis.ids.indexOf(id);
  assert.equal(analysis.ids.length, docs.length);
  const community = (id: string) => analysis.community[of(id)];
  assert.equal(community("a1"), community("hub"));
  assert.equal(community("b2"), community("b1"));
  assert.notEqual(community("a1"), community("b1"));
  // Importance lands on documents, and the most linked one of its group scores highest.
  const rank = (id: string) => analysis.rank[of(id)]!;
  for (const other of ["a1", "a2", "a3"]) assert.ok(rank("hub") > rank(other), other);
  // a3 is the only document joining the two groups: the top bridge.
  const bridge = (id: string) => analysis.bridge![of(id)]!;
  for (const other of analysis.ids.filter((id) => id !== "a3"))
    assert.ok(bridge("a3") > bridge(other), other);
  // Worth linking to a3: what shares its neighbours, never what it already links.
  const related = relatedRows(
    (await ns.query(RELATED, { id: docNode("a3") })).rows as unknown[][],
    "a3",
  ).map((row) => row.id);
  assert.ok(related.includes("a1") && related.includes("a2"), related.join(","));
  assert.ok(!related.includes("hub") && !related.includes("b1"), related.join(","));
  // Running it again replaces the derived links instead of adding to them.
  for (const step of ANALYSIS_STEPS) await ns.query(step);
  const linked = await ns.query("MATCH ()-[l:linked]->() RETURN count(l)");
  assert.equal(linked.rows[0]?.[0], 12);
});
