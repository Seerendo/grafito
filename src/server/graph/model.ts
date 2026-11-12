import { createHash } from "node:crypto";
import type { BatchOp } from "@grafenodb/client";
import { extractWikiLinks } from "../../domain/vault/links.ts";
import type { ManualLink } from "../../domain/vault/types.ts";

/**
 * How a vault is laid out in Grafeno. One namespace per vault owner. Grafito ids are not UUIDs,
 * so each record gets a stable UUID derived from its kind and id, and keeps its own id in `gid`.
 *
 * Links do not point at their target directly. A wiki link points at a Title node and a manual
 * link at a Ref node; every document points at its own Title (`titled`) and Ref (`is`). A link
 * therefore stays valid when its target is created later, renamed or moved to the trash, and
 * resolving it is one pattern: (a)-[:wiki]->(:Title)<-[:titled]-(b).
 */

export const EDGE_IS = "is";
export const EDGE_TITLED = "titled";
export const EDGE_WIKI = "wiki";
export const LINK_KINDS = ["referencia", "llama"] as const;

export type GraphDoc = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  /** Markdown text; only read for its [[wiki]] links. */
  content: string | null;
  links: ManualLink[];
};

export type GraphPortfolio = { id: string; links: ManualLink[] };

/** A namespace name valid in Grafeno: readable when the id allows it, hashed otherwise. */
export function namespaceFor(prefix: string, ownerId: string): string {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(ownerId)
    ? `${prefix}${ownerId}`
    : `${prefix}${createHash("sha256").update(ownerId).digest("hex").slice(0, 32)}`;
}

/** Deterministic UUID (version 8) for a Grafito record. */
export function nodeId(key: string): string {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Wiki links resolve by title without case, as findByTitle does. */
export function titleKey(title: string): string {
  return title.trim().toLowerCase();
}

export const docNode = (id: string) => nodeId(`doc:${id}`);
export const portfolioNode = (id: string) => nodeId(`portfolio:${id}`);
export const titleNode = (title: string) => nodeId(`title:${titleKey(title)}`);
/** Link target: a record of this vault, or one reached through another person's share. */
export const refNode = (targetId: string, shareId?: string) =>
  nodeId(shareId ? `ref:${shareId}:${targetId}` : `ref:${targetId}`);

function upsert(id: string, labels: string[], props: Record<string, unknown>): BatchOp {
  return { op: "upsert_node", node: { id, labels, props } };
}

function edge(from: string, label: string, to: string, props?: Record<string, unknown>): BatchOp {
  return { op: "create_edge", edge: { from, label, to, ...(props ? { props } : {}) } };
}

function linkOps(from: string, links: ManualLink[]): BatchOp[] {
  const ops: BatchOp[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!(LINK_KINDS as readonly string[]).includes(link.kind) || !link.targetId) continue;
    const target = refNode(link.targetId, link.shareId);
    const props: Record<string, unknown> = {};
    if (link.anchor) props.anchor = JSON.stringify(link.anchor);
    // One edge per kind and target; PDF phrases differ by anchor.
    const key = `${link.kind}|${target}|${props.anchor ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push(
      // A target in this vault is described by its own node; only a shared target keeps its kind
      // here, so two writers never disagree on a Ref's properties.
      upsert(
        target,
        ["Ref"],
        link.shareId
          ? {
              gid: link.targetId,
              share: link.shareId,
              ...(link.target === "portfolio" ? { target: "portfolio" } : {}),
            }
          : { gid: link.targetId },
      ),
      edge(from, link.kind, target, Object.keys(props).length ? props : undefined),
    );
  }
  return ops;
}

/** Replace a document's node and outgoing links. */
export function docOps(doc: GraphDoc): BatchOp[] {
  const self = docNode(doc.id);
  const ops: BatchOp[] = [
    upsert(self, [doc.kind === "file" ? "File" : "Note"], { gid: doc.id, kind: doc.kind }),
    { op: "delete_edges_from", from: self },
    upsert(refNode(doc.id), ["Ref"], { gid: doc.id }),
    edge(self, EDGE_IS, refNode(doc.id)),
  ];
  const own = titleKey(doc.title);
  if (own) {
    ops.push(
      upsert(titleNode(own), ["Title"], { key: own }),
      edge(self, EDGE_TITLED, titleNode(own)),
    );
  }
  if (doc.kind === "markdown" && doc.content) {
    for (const title of extractWikiLinks(doc.content)) {
      const key = titleKey(title);
      if (!key || key === own) continue;
      ops.push(upsert(titleNode(key), ["Title"], { key }), edge(self, EDGE_WIKI, titleNode(key)));
    }
  }
  ops.push(...linkOps(self, doc.links));
  return ops;
}

/** Replace a portfolio's node and outgoing links. */
export function portfolioOps(portfolio: GraphPortfolio): BatchOp[] {
  const self = portfolioNode(portfolio.id);
  return [
    upsert(self, ["Portfolio"], { gid: portfolio.id, kind: "portfolio" }),
    { op: "delete_edges_from", from: self },
    upsert(refNode(portfolio.id), ["Ref"], { gid: portfolio.id }),
    edge(self, EDGE_IS, refNode(portfolio.id)),
    ...linkOps(self, portfolio.links),
  ];
}

export function removeOps(kind: "doc" | "portfolio", id: string): BatchOp[] {
  return [{ op: "delete_node", id: kind === "doc" ? docNode(id) : portfolioNode(id) }];
}

/**
 * Split operations into batches no larger than max, keeping each record's operations together so
 * a failed batch never leaves a record half written.
 */
export function chunkOps(groups: BatchOp[][], max = 400): BatchOp[][] {
  const out: BatchOp[][] = [];
  let current: BatchOp[] = [];
  for (const group of groups) {
    if (current.length > 0 && current.length + group.length > max) {
      out.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) out.push(current);
  return out;
}

export type GraphEdgeRow = {
  from: string;
  to: string;
  kind: "wiki" | (typeof LINK_KINDS)[number];
  /** Set when the target is in another person's share. */
  shareId?: string;
  target?: "portfolio";
};

/** Every resolved link of a vault, both ends by Grafito id. */
export const ALL_EDGES = `
MATCH (a)-[r:referencia|llama]->(x:Ref)<-[:is]-(b) RETURN a.gid AS source, type(r) AS kind, b.gid AS target, null AS share, b.kind AS scope
UNION ALL MATCH (a)-[:wiki]->(:Title)<-[:titled]-(b) WHERE a <> b RETURN a.gid AS source, 'wiki' AS kind, b.gid AS target, null AS share, null AS scope
UNION ALL MATCH (a)-[r:referencia|llama]->(x:Ref) WHERE x.share IS NOT NULL RETURN a.gid AS source, type(r) AS kind, x.gid AS target, x.share AS share, x.target AS scope`;

export type IncomingRow = {
  source: string;
  kind: "wiki" | (typeof LINK_KINDS)[number];
  /** PDF phrase anchor of a manual link, as stored on the link (JSON). */
  anchor?: string;
};

type NamespaceReader = {
  neighbors(
    id: string,
    options: { direction?: "in" | "out" | "both"; labels?: string[] },
  ): Promise<{ node: string; edge: { label: string; props: Record<string, unknown> } }[]>;
  readMany(input: {
    nodes: string[];
  }): Promise<{ nodes: ({ props: Record<string, unknown> } | null)[] }>;
};

/** Neighbours of a node that may not exist yet (a title nobody has). */
async function into(ns: NamespaceReader, id: string, labels: string[]) {
  try {
    return await ns.neighbors(id, { direction: "in", labels });
  } catch (error) {
    if (error instanceof Error && "status" in error && (error as { status: number }).status === 404)
      return [];
    throw error;
  }
}

/**
 * What links to a record: manual links into its Ref, wiki links into its Title. Reads adjacency
 * directly, so it costs the same in a vault of ten notes or of a hundred thousand.
 */
export async function readIncoming(
  ns: NamespaceReader,
  target: { id: string; title?: string },
): Promise<IncomingRow[]> {
  const [manual, wiki] = await Promise.all([
    into(ns, refNode(target.id), [...LINK_KINDS]),
    target.title ? into(ns, titleNode(target.title), [EDGE_WIKI]) : Promise.resolve([]),
  ]);
  const hits = [...manual, ...wiki];
  const ids = [...new Set(hits.map((hit) => hit.node))];
  const gid = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 512) {
    const slice = ids.slice(start, start + 512);
    const read = await ns.readMany({ nodes: slice });
    read.nodes.forEach((node, index) => {
      const value = node?.props.gid;
      if (typeof value === "string") gid.set(slice[index]!, value);
    });
  }
  const out: IncomingRow[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const source = gid.get(hit.node);
    const kind = hit.edge.label;
    if (!source || source === target.id) continue;
    if (kind !== EDGE_WIKI && kind !== "referencia" && kind !== "llama") continue;
    const anchor = typeof hit.edge.props.anchor === "string" ? hit.edge.props.anchor : undefined;
    const key = `${kind}|${source}|${anchor ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, kind, ...(anchor ? { anchor } : {}) });
  }
  return out;
}

export function edgeRows(rows: unknown[][]): GraphEdgeRow[] {
  const out: GraphEdgeRow[] = [];
  const seen = new Set<string>();
  for (const [source, kind, target, share, scope] of rows) {
    if (typeof source !== "string" || typeof target !== "string" || source === target) continue;
    if (kind !== "wiki" && kind !== "referencia" && kind !== "llama") continue;
    const key = `${kind}|${source}|${target}|${share ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      from: source,
      to: target,
      kind,
      ...(typeof share === "string" ? { shareId: share } : {}),
      ...(scope === "portfolio" ? { target: "portfolio" as const } : {}),
    });
  }
  return out;
}

/**
 * Communities and importance. Links go through Title and Ref nodes, so PageRank would score
 * those instead of the documents: each analysis first writes direct `linked` edges between the
 * documents (as resolved now), then runs Louvain and PageRank on them and stores the results on
 * the nodes.
 */
export const EDGE_LINKED = "linked";
const DOCUMENT_LABELS = "['Note', 'File', 'Portfolio']";
export const ANALYSIS_STEPS = [
  `MATCH ()-[l:${EDGE_LINKED}]->() DELETE l`,
  `MATCH (a)-[:wiki]->(:Title)<-[:titled]-(b) WHERE a <> b MERGE (a)-[:${EDGE_LINKED}]->(b)`,
  `MATCH (a)-[:referencia|llama]->(:Ref)<-[:is]-(b) WHERE a <> b MERGE (a)-[:${EDGE_LINKED}]->(b)`,
  `CALL algo.louvain({labels: ${DOCUMENT_LABELS}, edgeLabels: '${EDGE_LINKED}', write: 'community'}) YIELD nodes RETURN nodes`,
  `CALL algo.pageRank({labels: ${DOCUMENT_LABELS}, edgeLabels: '${EDGE_LINKED}', write: 'rank'}) YIELD nodes RETURN nodes`,
];
export const READ_ANALYSIS = `MATCH (n) WHERE n.rank IS NOT NULL AND n.gid IS NOT NULL RETURN n.gid, n.community, n.rank`;

/** Per document: its community (numbered by size, largest first) and its PageRank score. */
export type Analysis = { ids: string[]; community: number[]; rank: number[] };

export function analysisRows(rows: unknown[][]): Analysis {
  const items: { id: string; community: number; rank: number }[] = [];
  for (const [id, community, rank] of rows) {
    if (typeof id !== "string" || typeof rank !== "number") continue;
    items.push({ id, community: typeof community === "number" ? community : -1, rank });
  }
  // Renumber communities by size so colours stay stable for the largest groups.
  const sizes = new Map<number, number>();
  for (const item of items) sizes.set(item.community, (sizes.get(item.community) ?? 0) + 1);
  const order = [...sizes.entries()]
    .filter(([community]) => community >= 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([community]) => community);
  const renumber = new Map(order.map((community, index) => [community, index]));
  return {
    ids: items.map((item) => item.id),
    community: items.map((item) => renumber.get(item.community) ?? -1),
    rank: items.map((item) => item.rank),
  };
}
