/**
 * Graph links on the wire. A large workspace has tens of thousands of links among a few thousand
 * records: each id is sent once, and each link is five numbers. Plain strings, because the server
 * function serializer wraps every array item and would triple the size.
 */

export type WireEdge = {
  from: string;
  to: string;
  kind: "wiki" | "referencia" | "llama";
  /** Set when the target is in another person's share. */
  shareId?: string;
  target?: "portfolio";
};

export type PackedEdges = {
  /** Record ids, one per line. */
  ids: string;
  /** Share ids, one per line. */
  shares: string;
  /** Per link, comma separated: from, to (indexes into ids), kind, share (index or -1), portfolio (0 or 1). */
  edges: string;
};

const KINDS = ["wiki", "referencia", "llama"] as const;
/** Ids never hold a line break. */
const LINE = String.fromCharCode(10);

export function packEdges(list: readonly WireEdge[]): PackedEdges {
  const ids: string[] = [];
  const shares: string[] = [];
  const idAt = new Map<string, number>();
  const shareAt = new Map<string, number>();
  const index = (map: Map<string, number>, out: string[], value: string) => {
    let at = map.get(value);
    if (at === undefined) {
      at = out.length;
      out.push(value);
      map.set(value, at);
    }
    return at;
  };
  const edges: number[] = [];
  for (const edge of list) {
    edges.push(
      index(idAt, ids, edge.from),
      index(idAt, ids, edge.to),
      KINDS.indexOf(edge.kind),
      edge.shareId ? index(shareAt, shares, edge.shareId) : -1,
      edge.target === "portfolio" ? 1 : 0,
    );
  }
  return { ids: ids.join(LINE), shares: shares.join(LINE), edges: edges.join(",") };
}

export function unpackEdges(packed: PackedEdges): WireEdge[] {
  const out: WireEdge[] = [];
  const ids = packed.ids ? packed.ids.split(LINE) : [];
  const shares = packed.shares ? packed.shares.split(LINE) : [];
  const edges = packed.edges ? packed.edges.split(",").map(Number) : [];
  for (let at = 0; at + 4 < edges.length; at += 5) {
    const from = ids[edges[at]!];
    const to = ids[edges[at + 1]!];
    const kind = KINDS[edges[at + 2]!];
    if (!from || !to || !kind) continue;
    const share = edges[at + 3]!;
    out.push({
      from,
      to,
      kind,
      ...(share >= 0 && shares[share] ? { shareId: shares[share] } : {}),
      ...(edges[at + 4] === 1 ? { target: "portfolio" as const } : {}),
    });
  }
  return out;
}

/**
 * Community, importance and bridging of the shown documents. Importance (PageRank) and bridging
 * (betweenness) are scaled to 0–1000 against the highest document shown; communities are
 * numbered by size, largest first.
 */
export type PackedAnalysis = {
  /** Record ids, one per line. */
  ids: string;
  /** Comma separated, one per id; -1 for none. */
  community: string;
  /** Comma separated, one per id, 0 to 1000. */
  rank: string;
  /** Comma separated, one per id, 0 to 1000. */
  bridge: string;
};

export type NodeAnalysis = { community: number; rank: number; bridge: number };

function scaled(values: number[]): number[] {
  const top = values.reduce((max, value) => (value > max ? value : max), 0);
  return values.map((value) => (top > 0 ? Math.round((value / top) * 1000) : 0));
}

export function packAnalysis(
  analysis: { ids: string[]; community: number[]; rank: number[]; bridge?: number[] } | null,
  keep?: (id: string) => boolean,
): PackedAnalysis {
  const ids: string[] = [];
  const community: number[] = [];
  const rank: number[] = [];
  const bridge: number[] = [];
  if (analysis) {
    analysis.ids.forEach((id, index) => {
      if (keep && !keep(id)) return;
      ids.push(id);
      community.push(analysis.community[index] ?? -1);
      rank.push(analysis.rank[index] ?? 0);
      bridge.push(analysis.bridge?.[index] ?? 0);
    });
  }
  return {
    ids: ids.join(LINE),
    community: community.join(","),
    rank: scaled(rank).join(","),
    bridge: scaled(bridge).join(","),
  };
}

export function unpackAnalysis(packed: PackedAnalysis | undefined): Map<string, NodeAnalysis> {
  const out = new Map<string, NodeAnalysis>();
  if (!packed?.ids) return out;
  const ids = packed.ids.split(LINE);
  const community = packed.community.split(",").map(Number);
  const rank = packed.rank.split(",").map(Number);
  const bridge = packed.bridge ? packed.bridge.split(",").map(Number) : [];
  ids.forEach((id, index) => {
    out.set(id, {
      community: community[index] ?? -1,
      rank: rank[index] ?? 0,
      bridge: bridge[index] ?? 0,
    });
  });
  return out;
}
