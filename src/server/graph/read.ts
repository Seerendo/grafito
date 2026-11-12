import type { Sql } from "@/lib/db";
import { unpackTree } from "@/domain/share-pack";
import type { SharedTree } from "@/domain/shared-tree";
import type { TextAnchor } from "@/domain/vault/anchor";
import { vaultIndex } from "@/server/vault-index";
import { grafeno, grafenoReachable, markGrafenoDown, ownerNamespace } from "./grafeno";
import {
  ALL_EDGES,
  RELATED,
  docNode,
  edgeRows,
  portfolioNode,
  readIncoming,
  relatedRows,
  type GraphEdgeRow,
} from "./model";
import { graphPluginOn } from "./sync";

/**
 * Reads of the graph: every link of a vault, the links inside a share, and what points at one
 * document. Callers check access first; these only read the owner's namespace.
 *
 * A share's links are those of its owner's vault between records the reader can see. Reading
 * the whole vault once is far cheaper in Grafeno than asking for thousands of records by id, and
 * the result is kept per owner until Grafeno holds a newer revision.
 */

export type IncomingLink = {
  source: string;
  kind: "wiki" | "referencia" | "llama";
  anchor?: TextAnchor;
};

/** The graph is usable: plugin on, engine configured and answering. */
export async function graphOnline(sql: Sql): Promise<boolean> {
  return Boolean(grafeno()) && (await graphPluginOn(sql)) && (await grafenoReachable());
}

async function syncedRevision(sql: Sql, ownerId: string): Promise<string | null> {
  const rows = await sql<{ rev: unknown; synced_at: unknown }>`
    select rev, synced_at from graph_sync where owner_id = ${ownerId} limit 1
  `;
  const row = rows[0];
  return row && Number(row.rev) >= 0 ? `${String(row.rev)}:${String(row.synced_at)}` : null;
}

/** Whether Grafeno already holds this owner's vault. Until then the graph is still filling. */
export async function graphReady(sql: Sql, ownerId: string): Promise<boolean> {
  return (await syncedRevision(sql, ownerId)) !== null;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "status" in error && (error as { status: number }).status === 404
  );
}

/** A failure that is not an HTTP answer means the engine stopped answering. */
function noteFailure(error: unknown): void {
  if (!(error instanceof Error && "status" in error)) markGrafenoDown();
}

const MAX_CACHED = 50;
const cache = new Map<string, { version: string; edges: GraphEdgeRow[] }>();

/** Every link of an owner's vault, including links to shared targets. */
async function ownerEdges(sql: Sql, ownerId: string): Promise<GraphEdgeRow[]> {
  const engine = grafeno();
  if (!engine) throw new Error("Grafeno no está configurado.");
  const version = await syncedRevision(sql, ownerId);
  const cached = cache.get(ownerId);
  if (version && cached?.version === version) {
    cache.delete(ownerId);
    cache.set(ownerId, cached);
    return cached.edges;
  }
  let edges: GraphEdgeRow[];
  try {
    const result = await engine.namespace(ownerNamespace(ownerId)).query(ALL_EDGES);
    edges = edgeRows(result.rows as unknown[][]);
  } catch (error) {
    // A namespace not copied yet answers as empty, not as an outage.
    if (isNotFound(error)) return [];
    noteFailure(error);
    throw error;
  }
  if (version) {
    cache.delete(ownerId);
    cache.set(ownerId, { version, edges });
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return edges;
}

export function vaultEdges(sql: Sql, ownerId: string): Promise<GraphEdgeRow[]> {
  return ownerEdges(sql, ownerId);
}

/** Records a share shows: its documents and portfolios. */
export function visibleIds(tree: SharedTree): Set<string> {
  return new Set([
    ...tree.documents.map((document) => document.id),
    ...tree.portfolios.map((portfolio) => portfolio.id),
  ]);
}

/** Links between records of a share, both ends visible to the reader. */
export async function edgesWithin(
  sql: Sql,
  ownerId: string,
  visible: Set<string>,
): Promise<GraphEdgeRow[]> {
  if (visible.size === 0) return [];
  const edges = await ownerEdges(sql, ownerId);
  return edges.filter((edge) => !edge.shareId && visible.has(edge.from) && visible.has(edge.to));
}

function parseAnchor(text: string | undefined): TextAnchor | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as TextAnchor;
  } catch {
    return undefined;
  }
}

const RELATED_SHOWN = 5;

/**
 * Documents worth linking to this one: they share neighbours with it and are not linked to it
 * yet (Grafeno's link prediction on the links of the last analysis). Only visible ones when a
 * share is read. Empty before the first analysis.
 */
export async function relatedDocs(
  ownerId: string,
  target: { kind: "doc" | "portfolio"; id: string },
  visible?: Set<string>,
): Promise<{ id: string; score: number }[]> {
  const engine = grafeno();
  if (!engine) throw new Error("Grafeno no está configurado.");
  const node = target.kind === "doc" ? docNode(target.id) : portfolioNode(target.id);
  try {
    const result = await engine.namespace(ownerNamespace(ownerId)).query(RELATED, { id: node });
    return relatedRows(result.rows as unknown[][], target.id)
      .filter((row) => !visible || visible.has(row.id))
      .slice(0, RELATED_SHOWN);
  } catch (error) {
    // A document not copied yet, or an engine without link prediction: nothing to suggest.
    if (error instanceof Error && "status" in error) return [];
    noteFailure(error);
    throw error;
  }
}

/** What links to a document or portfolio, optionally only from visible sources. */
export async function incomingLinks(
  sql: Sql,
  ownerId: string,
  target: { kind: "doc" | "portfolio"; id: string },
  visible?: Set<string>,
): Promise<IncomingLink[]> {
  const engine = grafeno();
  if (!engine) throw new Error("Grafeno no está configurado.");
  let title: string | undefined;
  if (target.kind === "doc") {
    const index = await vaultIndex(sql, ownerId);
    title = index?.docById.get(target.id)?.title;
  }
  try {
    const rows = await readIncoming(engine.namespace(ownerNamespace(ownerId)), {
      id: target.id,
      title,
    });
    return rows
      .filter((row) => !visible || visible.has(row.source))
      .map((row) => {
        const anchor = parseAnchor(row.anchor);
        return { source: row.source, kind: row.kind, ...(anchor ? { anchor } : {}) };
      });
  } catch (error) {
    if (isNotFound(error)) return [];
    noteFailure(error);
    throw error;
  }
}

/** Unpack a share tree response into the reader's view. */
export function treeOf(response: { share: SharedTree["share"]; body: () => string }): SharedTree {
  return unpackTree({ share: response.share, body: response.body() });
}
