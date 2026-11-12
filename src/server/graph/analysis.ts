import type { Sql } from "@/lib/db";
import { grafenoSlow, ownerNamespace } from "./grafeno";
import { ANALYSIS_STEPS, READ_ANALYSIS, analysisRows, type Analysis } from "./model";

/**
 * Communities (Louvain) and importance (PageRank) of each vault's documents, computed in
 * Grafeno. A vault is analysed again only when Grafeno holds a newer revision and at most once
 * every 30 s, because on a large vault it takes seconds. The result is kept in graph_analysis:
 * a document written since keeps its last community until the next analysis.
 */

const ANALYZE_MS = 30_000;
const OWNERS_PER_PASS = 2;

export async function analyzeOwner(sql: Sql, ownerId: string, revision: number): Promise<void> {
  const engine = grafenoSlow();
  if (!engine) return;
  const ns = engine.namespace(ownerNamespace(ownerId));
  for (const step of ANALYSIS_STEPS) await ns.query(step);
  const result = await ns.query(READ_ANALYSIS);
  const data = JSON.stringify(analysisRows(result.rows as unknown[][]));
  const now = Date.now();
  await sql`
    insert into graph_analysis (owner_id, rev, analyzed_at, data)
    values (${ownerId}, ${revision}, ${now}, ${data})
    on conflict (owner_id) do update set
      rev = excluded.rev, analyzed_at = excluded.analyzed_at, data = excluded.data
  `;
}

/** Analyse the vaults that changed since their last analysis, a couple per pass. */
export async function analysisPass(sql: Sql): Promise<void> {
  const owners = await sql<{ owner_id: string; rev: unknown }>`
    select g.owner_id, g.rev
    from graph_sync g left join graph_analysis a on a.owner_id = g.owner_id
    where g.rev >= 0 and (a.owner_id is null or (g.rev > a.rev and a.analyzed_at < ${Date.now() - ANALYZE_MS}))
    order by a.analyzed_at nulls first
    limit ${OWNERS_PER_PASS}
  `;
  for (const owner of owners) {
    try {
      await analyzeOwner(sql, owner.owner_id, Number(owner.rev));
    } catch {
      // Try again later; the graph works without communities.
      await sql`
        insert into graph_analysis (owner_id, rev, analyzed_at) values (${owner.owner_id}, -1, ${Date.now()})
        on conflict (owner_id) do update set analyzed_at = excluded.analyzed_at
      `;
    }
  }
}

const cache = new Map<string, { rev: number; at: number; analysis: Analysis }>();
const MAX_CACHED = 50;

/** The latest analysis of a vault, or null before the first one. */
export async function readAnalysis(sql: Sql, ownerId: string): Promise<Analysis | null> {
  const rows = await sql<{ rev: unknown; analyzed_at: unknown }>`
    select rev, analyzed_at from graph_analysis where owner_id = ${ownerId} limit 1
  `;
  const row = rows[0];
  if (!row || Number(row.rev) < 0) return null;
  const rev = Number(row.rev);
  const at = Number(row.analyzed_at);
  const cached = cache.get(ownerId);
  if (cached && cached.rev === rev && cached.at === at) return cached.analysis;
  const data = await sql<{ data: string }>`
    select data from graph_analysis where owner_id = ${ownerId} limit 1
  `;
  let analysis: Analysis;
  try {
    analysis = JSON.parse(data[0]?.data ?? "{}") as Analysis;
    if (!Array.isArray(analysis.ids)) return null;
  } catch {
    return null;
  }
  cache.delete(ownerId);
  cache.set(ownerId, { rev, at, analysis });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return analysis;
}

/** Forget every analysis, so they run again (Reconstruir). */
export async function clearAnalyses(sql: Sql): Promise<void> {
  await sql`delete from graph_analysis`;
  cache.clear();
}
