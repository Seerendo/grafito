import type { BatchOp } from "@grafenodb/client";
import type { Sql } from "@/lib/db";
import { claimJob } from "@/server/jobs";
import { parseLinks } from "@/server/vault-index";
import {
  grafeno,
  grafenoReachable,
  grafenoVersion,
  markGrafenoDown,
  namespacePrefix,
  ownerNamespace,
} from "./grafeno";
import { chunkOps, docOps, portfolioOps, removeOps } from "./model";
import { onGraphNudge } from "./nudge";
import { analysisPass, clearAnalyses } from "./analysis";

/**
 * Copies vaults from Postgres into Grafeno. Postgres stays the source of truth; Grafeno holds
 * the links between notes, files and portfolios so the graph and mentions are read without
 * scanning every document. Each owner's vault_state revision says what changed: a pass writes
 * the rows with a newer rev and records the revision in graph_sync. One replica syncs at a time.
 */

const TICK_MS = 2_000;
/** After a write, wait for it to commit before reading. */
const NUDGE_MS = 800;
const LOCK = "graph-sync";
const LOCK_MS = 120_000;
const OWNERS_PER_PASS = 25;
const PAGE = 1_000;
/**
 * A revision is reserved before its rows are written, so a pass can read the revision while a
 * write is still running. Each pass re-reads this many revisions back; rewriting is harmless.
 */
const OVERLAP = 20;
const HEAL_MS = 5 * 60_000;

type DocRow = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  content: string | null;
  links_json: string | null;
  deleted: unknown;
};

type PortfolioRow = { id: string; links_json: string | null; deleted: unknown };

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

/** The Grafo plugin, on unless an administrator paused it. */
export async function graphPluginOn(sql: Sql): Promise<boolean> {
  const rows = await sql<{
    enabled: unknown;
  }>`select enabled from app_plugin where id = 'grafo' limit 1`;
  return !rows[0] || flag(rows[0].enabled);
}

/** Delete a node whether or not it reached Grafeno: a lone delete of a missing node fails. */
function gone(kind: "doc" | "portfolio", id: string): BatchOp[] {
  const [remove] = removeOps(kind, id) as [{ op: "delete_node"; id: string }];
  return [{ op: "upsert_node", node: { id: remove.id, labels: ["Gone"], props: {} } }, remove];
}

async function writeOps(namespace: string, groups: BatchOp[][]): Promise<void> {
  const engine = grafeno();
  if (!engine || groups.length === 0) return;
  const ns = engine.namespace(namespace);
  for (const batch of chunkOps(groups)) await ns.batch(batch);
}

/** Write one owner's changes since a revision; a negative revision copies the whole vault. */
export async function syncOwner(
  sql: Sql,
  ownerId: string,
  since: number,
  revision: number,
): Promise<void> {
  const engine = grafeno();
  if (!engine) return;
  const namespace = ownerNamespace(ownerId);
  const whole = since < 0;
  if (whole) {
    // Start clean: the engine may hold an older copy of this vault.
    await engine.dropNamespace(namespace).catch(() => undefined);
  }
  const from = whole ? -1 : Math.max(-1, since - OVERLAP);

  const portfolios = await sql<PortfolioRow>`
    select id, links_json, deleted from vault_portfolio where user_id = ${ownerId} and rev > ${from}
  `;
  await writeOps(
    namespace,
    portfolios.flatMap((row) =>
      flag(row.deleted)
        ? whole
          ? []
          : [gone("portfolio", row.id)]
        : [portfolioOps({ id: row.id, links: parseLinks(row.links_json) })],
    ),
  );

  // Pages by id, so a large vault is never read into memory at once.
  let after = "";
  for (;;) {
    const docs = await sql<DocRow>`
      select id, title, kind, case when kind = 'markdown' then content else null end as content,
        links_json, deleted
      from vault_doc
      where user_id = ${ownerId} and rev > ${from} and id > ${after}
      order by id limit ${PAGE}
    `;
    if (docs.length === 0) break;
    await writeOps(
      namespace,
      docs.flatMap((row) =>
        flag(row.deleted)
          ? whole
            ? []
            : [gone("doc", row.id)]
          : [
              docOps({
                id: row.id,
                title: row.title,
                kind: row.kind,
                content: row.content,
                links: parseLinks(row.links_json),
              }),
            ],
      ),
    );
    after = docs[docs.length - 1]!.id;
    if (docs.length < PAGE) break;
  }

  const now = Date.now();
  await sql`
    insert into graph_sync (owner_id, rev, synced_at, last_error) values (${ownerId}, ${revision}, ${now}, '')
    on conflict (owner_id) do update set rev = excluded.rev, synced_at = excluded.synced_at, last_error = ''
  `;
}

async function noteError(sql: Sql, ownerId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await sql`
    insert into graph_sync (owner_id, rev, synced_at, last_error) values (${ownerId}, -1, 0, ${message})
    on conflict (owner_id) do update set last_error = excluded.last_error
  `.catch(() => undefined);
}

let lastHeal = 0;

/**
 * Copy vaults again whose namespace the engine lost (a new or restored engine volume), and drop
 * namespaces of owners that no longer exist.
 */
async function heal(sql: Sql): Promise<void> {
  if (Date.now() - lastHeal < HEAL_MS) return;
  lastHeal = Date.now();
  const engine = grafeno();
  if (!engine) return;
  const held = new Set((await engine.namespaces()).map((item) => item.name));
  const rows = await sql<{ owner_id: string; alive: unknown }>`
    select g.owner_id, (s.user_id is not null) as alive
    from graph_sync g left join vault_state s on s.user_id = g.owner_id
  `;
  const known = new Set<string>();
  for (const row of rows) {
    const namespace = ownerNamespace(row.owner_id);
    if (!flag(row.alive)) {
      await engine.dropNamespace(namespace).catch(() => undefined);
      await sql`delete from graph_sync where owner_id = ${row.owner_id}`;
      continue;
    }
    known.add(namespace);
    if (!held.has(namespace)) await sql`delete from graph_sync where owner_id = ${row.owner_id}`;
  }
  const owners = await sql<{ user_id: string }>`select user_id from vault_state`;
  for (const owner of owners) known.add(ownerNamespace(owner.user_id));
  const prefix = namespacePrefix();
  for (const name of held) {
    if (name.startsWith(prefix) && !known.has(name)) {
      await engine.dropNamespace(name).catch(() => undefined);
    }
  }
}

async function release(sql: Sql): Promise<void> {
  await sql`update app_setting set value = '0' where key = ${`job:${LOCK}`}`;
}

let running = false;

/** One pass: the vaults whose revision moved past what Grafeno holds. */
export async function graphPass(sql: Sql): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!grafeno() || !(await graphPluginOn(sql)) || !(await grafenoReachable())) return;
    if (!(await claimJob(sql, LOCK, LOCK_MS))) return;
    try {
      await heal(sql);
      const owners = await sql<{ user_id: string; revision: unknown; rev: unknown }>`
        select s.user_id, s.revision, g.rev
        from vault_state s left join graph_sync g on g.owner_id = s.user_id
        where g.owner_id is null or s.revision > g.rev
        order by g.owner_id is not null, s.user_id
        limit ${OWNERS_PER_PASS}
      `;
      for (const owner of owners) {
        const since = owner.rev === null || owner.rev === undefined ? -1 : Number(owner.rev);
        try {
          await syncOwner(sql, owner.user_id, since, Number(owner.revision));
        } catch (error) {
          await noteError(sql, owner.user_id, error);
          // The engine stopped answering: wait for the next health check instead of failing
          // every owner in this pass.
          if (!(error instanceof Error && "status" in error)) {
            markGrafenoDown();
            break;
          }
        }
      }
      // Communities and importance follow, at their own slower pace.
      await analysisPass(sql);
    } finally {
      await release(sql);
    }
  } finally {
    running = false;
  }
}

const globalRef = globalThis as typeof globalThis & {
  __grafitoGraphSync__?: ReturnType<typeof setInterval>;
};

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

async function passNow(): Promise<void> {
  const { getSql } = await import("@/lib/db");
  await graphPass(await getSql()).catch(() => undefined);
}

/** Start the loop once per process. */
export function startGraphSync(): void {
  if (globalRef.__grafitoGraphSync__ || !grafeno()) return;
  onGraphNudge(() => {
    if (nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      void passNow();
    }, NUDGE_MS);
  });
  globalRef.__grafitoGraphSync__ = setInterval(() => void passNow(), TICK_MS);
  void passNow();
}

/** Copy every vault again (Administración → Monitorización → Grafo). */
export async function requestGraphRebuild(sql: Sql): Promise<void> {
  await sql`delete from graph_sync`;
  await clearAnalyses(sql);
  lastHeal = 0;
}

export type GraphSyncStatus = {
  configured: boolean;
  reachable: boolean;
  plugin: boolean;
  vaults: number;
  synced: number;
  pending: number;
  lastError: string;
  lastSyncedAt: number | null;
  version: string;
  /** Vaults with communities and importance computed. */
  analyzed: number;
};

export async function readGraphStatus(sql: Sql): Promise<GraphSyncStatus> {
  const [counts] = await sql<{ vaults: unknown; synced: unknown; last: unknown }>`
    select count(*) as vaults,
      count(*) filter (where g.owner_id is not null and g.rev >= s.revision) as synced,
      max(g.synced_at) as last
    from vault_state s left join graph_sync g on g.owner_id = s.user_id
  `;
  const errors = await sql<{ last_error: string }>`
    select last_error from graph_sync where last_error <> '' order by synced_at desc limit 1
  `;
  const analyzed = await sql<{ n: unknown }>`
    select count(*) as n from graph_analysis where rev >= 0
  `;
  const vaults = Number(counts?.vaults ?? 0);
  const synced = Number(counts?.synced ?? 0);
  const last = Number(counts?.last ?? 0);
  return {
    configured: Boolean(grafeno()),
    reachable: await grafenoReachable(),
    plugin: await graphPluginOn(sql),
    vaults,
    synced,
    pending: Math.max(0, vaults - synced),
    lastError: errors[0]?.last_error ?? "",
    lastSyncedAt: last > 0 ? last : null,
    version: grafenoVersion(),
    analyzed: Number(analyzed[0]?.n ?? 0),
  };
}
