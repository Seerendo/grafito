import { indexBody } from "@/domain/search-text";
import type { Sql } from "@/lib/db";
import { fileText } from "@/server/files";
import { claimJob } from "@/server/jobs";
import { deleteElasticDoc, upsertElasticDoc } from "@/server/search";
import { getDoc } from "@/server/vault";

/**
 * Indexación de contenido en segundo plano. Cada vuelta toma un documento
 * (nota, tabla o archivo) y guarda su texto en Postgres y, si hay, en
 * Elasticsearch. No usa modelos: el texto sale del Markdown, de las celdas
 * o del propio archivo (PDF, Office, OpenDocument). Una sola instancia lo
 * hace a la vez, y suelta el turno al terminar para no frenar el resto.
 */

const TICK_MS = 800;
const LOCK = "content-index";

type Pending = {
  user_id: string;
  id: string;
  rev: unknown;
  title: string;
  kind: "markdown" | "file";
  portfolio_id: string | null;
  content: string;
  links_json: string;
  file_name: string | null;
};

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

async function documentsEnabled(sql: Sql): Promise<boolean> {
  const rows = await sql<{ enabled: unknown }>`select enabled from app_source where id = 'documents' limit 1`;
  return !rows[0] || flag(rows[0].enabled);
}

async function release(sql: Sql): Promise<void> {
  await sql`update app_setting set value = '0' where key = ${`job:${LOCK}`}`;
}

async function touch(sql: Sql, title: string, error = ""): Promise<void> {
  const now = Date.now();
  await sql`
    insert into index_run (id, current_title, last_error, updated_at)
    values ('content', ${title}, ${error}, ${now})
    on conflict (id) do update set
      current_title = excluded.current_title,
      last_error = case when excluded.last_error = '' then index_run.last_error else excluded.last_error end,
      updated_at = excluded.updated_at
  `;
}

/** Quita del índice lo que ya no está en la bóveda. Unos pocos por vuelta. */
async function forgetRemoved(sql: Sql): Promise<boolean> {
  const rows = await sql<{ user_id: string; doc_id: string }>`
    select c.user_id, c.doc_id from content_index c
    left join vault_doc d on d.user_id = c.user_id and d.id = c.doc_id and not d.deleted
    where d.id is null
    limit 10
  `;
  for (const row of rows) {
    await sql`delete from content_index where user_id = ${row.user_id} and doc_id = ${row.doc_id}`;
    await sql`delete from doc_index where user_id = ${row.user_id} and doc_id = ${row.doc_id}`;
    await deleteElasticDoc(row.user_id, row.doc_id);
  }
  return rows.length > 0;
}

async function bodyOf(sql: Sql, row: Pending): Promise<string> {
  const extra = await sql<{ search_text: string }>`
    select search_text from data_meta where owner_id = ${row.user_id} and doc_id = ${row.id} limit 1
  `;
  const cells = extra[0]?.search_text ?? "";
  if (row.kind === "markdown") return indexBody([row.content, cells]);
  const doc = await getDoc(sql, row.user_id, row.id);
  const extracted = doc ? ((await fileText(sql, doc, 24_000)) ?? "") : "";
  const name = row.file_name ?? doc?.file?.name ?? "";
  return indexBody([name, extracted, cells]);
}

async function indexOne(sql: Sql, row: Pending): Promise<void> {
  const rev = Number(row.rev);
  await touch(sql, row.title);
  try {
    const body = await bodyOf(sql, row);
    await sql`
      insert into doc_index (user_id, doc_id, title, kind, portfolio_id, body, links_json, updated_at)
      values (
        ${row.user_id}, ${row.id}, ${row.title}, ${row.kind}, ${row.portfolio_id},
        ${body}, ${row.links_json || "[]"}, now()
      )
      on conflict (user_id, doc_id) do update set
        title = excluded.title,
        kind = excluded.kind,
        portfolio_id = excluded.portfolio_id,
        body = excluded.body,
        links_json = excluded.links_json,
        updated_at = now()
    `;
    await upsertElasticDoc(row.user_id, {
      id: row.id,
      title: row.title,
      kind: row.kind,
      portfolioId: row.portfolio_id,
      body,
      links: [],
    });
    await sql`
      insert into content_index (user_id, doc_id, rev, chars, ok, error, indexed_at)
      values (${row.user_id}, ${row.id}, ${rev}, ${body.length}, true, '', ${Date.now()})
      on conflict (user_id, doc_id) do update set
        rev = excluded.rev, chars = excluded.chars, ok = true, error = '', indexed_at = excluded.indexed_at
    `;
  } catch (error) {
    const message = (error instanceof Error ? error.message : "No se pudo indexar.").slice(0, 300);
    await sql`
      insert into content_index (user_id, doc_id, rev, chars, ok, error, indexed_at)
      values (${row.user_id}, ${row.id}, ${rev}, 0, false, ${message}, ${Date.now()})
      on conflict (user_id, doc_id) do update set
        rev = excluded.rev, chars = 0, ok = false, error = excluded.error, indexed_at = excluded.indexed_at
    `;
    await touch(sql, row.title, message);
  }
}

/** Una vuelta: olvida lo borrado o indexa el documento más atrasado. */
export async function indexStep(sql: Sql): Promise<void> {
  if (!(await documentsEnabled(sql))) {
    await touch(sql, "");
    return;
  }
  if (await forgetRemoved(sql)) return;
  const rows = await sql<Pending>`
    select d.user_id, d.id, d.rev, d.title, d.kind, d.portfolio_id, d.content, d.links_json, d.file_name
    from vault_doc d
    left join content_index c on c.user_id = d.user_id and c.doc_id = d.id
    where not d.deleted and (c.doc_id is null or c.rev <> d.rev)
    order by d.updated_at asc
    limit 1
  `;
  const row = rows[0];
  if (!row) {
    await touch(sql, "");
    return;
  }
  await indexOne(sql, row);
}

export type IndexStatus = {
  total: number;
  done: number;
  failed: number;
  pending: number;
  current: string;
  lastError: string;
  updatedAt: number;
  engine: "elasticsearch" | "postgres";
};

export async function readIndexStatus(sql: Sql): Promise<IndexStatus> {
  const { documentEngine } = await import("@/server/platform");
  const counts = await sql<{ total: number; done: number; failed: number }>`
    select
      (select count(*)::int from vault_doc where not deleted) as total,
      (select count(*)::int from content_index c
        join vault_doc d on d.user_id = c.user_id and d.id = c.doc_id and not d.deleted
        where c.rev = d.rev and c.ok) as done,
      (select count(*)::int from content_index c
        join vault_doc d on d.user_id = c.user_id and d.id = c.doc_id and not d.deleted
        where c.rev = d.rev and not c.ok) as failed
  `;
  const run = await sql<{ current_title: string; last_error: string; updated_at: unknown }>`
    select current_title, last_error, updated_at from index_run where id = 'content' limit 1
  `;
  const total = Number(counts[0]?.total ?? 0);
  const done = Number(counts[0]?.done ?? 0);
  const failed = Number(counts[0]?.failed ?? 0);
  return {
    total,
    done,
    failed,
    pending: Math.max(0, total - done - failed),
    current: run[0]?.current_title ?? "",
    lastError: run[0]?.last_error ?? "",
    updatedAt: Number(run[0]?.updated_at ?? 0),
    engine: documentEngine(),
  };
}

/** Olvida las marcas. La búsqueda sigue con el texto ya guardado hasta que se reescribe. */
export async function requestReindex(sql: Sql): Promise<void> {
  await sql`delete from content_index`;
  const now = Date.now();
  await sql`
    insert into index_run (id, current_title, last_error, updated_at)
    values ('content', '', '', ${now})
    on conflict (id) do update set current_title = '', last_error = '', updated_at = excluded.updated_at
  `;
}

const globalRef = globalThis as typeof globalThis & { __grafitoIndexer__?: ReturnType<typeof setInterval> };
let busy = false;

/** Arranca el barrido (una vez por proceso). */
export function startContentIndex(): void {
  if (globalRef.__grafitoIndexer__) return;
  globalRef.__grafitoIndexer__ = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        if (!(await claimJob(sql, LOCK, 30_000))) return;
        try {
          await indexStep(sql);
        } finally {
          await release(sql);
        }
      } catch (error) {
        console.error("[index]", error);
      } finally {
        busy = false;
      }
    })();
  }, TICK_MS);
  globalRef.__grafitoIndexer__.unref?.();
}
