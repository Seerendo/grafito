import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import {
  cleanCell,
  FIELD_TYPES,
  MAX_FIELDS,
  MAX_ROWS,
  type CellValue,
  type FieldType,
  type TableField,
  type TableRow,
  type VaultRef,
} from "@/domain/vault/table";
import type { ManualLink } from "@/domain/vault/types";
import { nextRevision } from "./vault";

/**
 * Datos de las tablas (solo servidor). Ver `migrations/0026_tables.sql` y
 * `domain/vault/table.ts`. Todo va por dueño (`ownerId`, el de la bóveda
 * donde está la tabla) y documento; quién puede leer o cambiar lo decide
 * `table.functions.ts`.
 */

type FieldRow = { id: string; name: string; type: string; options: string; position: unknown; width: unknown };
type DataRow = { id: string; position: unknown; cells: unknown; updated_at: unknown; updated_by: string; deleted?: unknown };

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

function toField(row: FieldRow): TableField {
  let options: { choices?: unknown } = {};
  try {
    options = JSON.parse(row.options) as { choices?: unknown };
  } catch {
    /* sin opciones */
  }
  const type = (FIELD_TYPES as readonly string[]).includes(row.type) ? (row.type as FieldType) : "text";
  return {
    id: row.id,
    name: row.name,
    type,
    ...(Array.isArray(options.choices) ? { choices: options.choices.filter((choice): choice is string => typeof choice === "string") } : {}),
    position: Number(row.position),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
  };
}

function toRow(row: DataRow): TableRow {
  const cells = typeof row.cells === "string" ? (JSON.parse(row.cells) as Record<string, CellValue>) : ((row.cells ?? {}) as Record<string, CellValue>);
  return { id: row.id, position: Number(row.position), cells, updatedAt: Number(row.updated_at), updatedBy: row.updated_by };
}

export async function readFields(sql: Sql, ownerId: string, docId: string): Promise<TableField[]> {
  const rows = await sql<FieldRow>`
    select id, name, type, options, position, width from data_field
    where owner_id = ${ownerId} and doc_id = ${docId} order by position, name
  `;
  return rows.map(toField);
}

/** Columnas y filas. Una tabla nueva empieza con una columna «Nombre». */
export async function readTable(
  sql: Sql,
  ownerId: string,
  docId: string,
  canCreate: boolean,
): Promise<{ fields: TableField[]; rows: TableRow[]; at: number }> {
  const at = Date.now();
  let fields = await readFields(sql, ownerId, docId);
  if (fields.length === 0 && canCreate) {
    await saveField(sql, ownerId, docId, { id: randomUUID(), name: "Nombre", type: "text", position: 0 });
    fields = await readFields(sql, ownerId, docId);
  }
  const rows = await sql<DataRow>`
    select id, position, cells, updated_at, updated_by from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and not deleted
    order by position limit ${MAX_ROWS}
  `;
  return { fields, rows: rows.map(toRow), at };
}

/** Lo que cambió desde `since` (también las filas borradas), para ver lo de los demás sin recargar. */
export async function rowsSince(
  sql: Sql,
  ownerId: string,
  docId: string,
  since: number,
): Promise<{ rows: TableRow[]; deleted: string[]; fields: TableField[]; at: number }> {
  const at = Date.now();
  const changed = await sql<DataRow>`
    select id, position, cells, updated_at, updated_by, deleted from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and updated_at > ${since}
    order by updated_at limit ${MAX_ROWS}
  `;
  return {
    rows: changed.filter((row) => !flag(row.deleted)).map(toRow),
    deleted: changed.filter((row) => flag(row.deleted)).map((row) => row.id),
    fields: await readFields(sql, ownerId, docId),
    at,
  };
}

export async function saveField(
  sql: Sql,
  ownerId: string,
  docId: string,
  field: Omit<TableField, "position"> & { position?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = field.name.trim().slice(0, 120) || "Columna";
  const type = (FIELD_TYPES as readonly string[]).includes(field.type) ? field.type : "text";
  const choices = type === "select" ? [...new Set((field.choices ?? []).map((choice) => choice.trim().slice(0, 120)).filter(Boolean))].slice(0, 100) : undefined;
  const existing = await sql<{ id: string; type: string }>`
    select id, type from data_field where owner_id = ${ownerId} and doc_id = ${docId}
  `;
  const current = existing.find((row) => row.id === field.id);
  if (!current && existing.length >= MAX_FIELDS) return { ok: false, error: `Una tabla tiene como mucho ${MAX_FIELDS} columnas.` };
  const position =
    field.position ??
    (current ? undefined : (await sql<{ next: unknown }>`
      select coalesce(max(position), -1) + 1 as next from data_field where owner_id = ${ownerId} and doc_id = ${docId}
    `)[0]?.next);
  await sql`
    insert into data_field (owner_id, doc_id, id, name, type, options, position, width)
    values (${ownerId}, ${docId}, ${field.id}, ${name}, ${type}, ${JSON.stringify(choices ? { choices } : {})},
      ${Number(position ?? 0)}, ${field.width ?? null})
    on conflict (owner_id, doc_id, id) do update set
      name = excluded.name, type = excluded.type, options = excluded.options,
      position = coalesce(${field.position ?? null}, data_field.position), width = excluded.width
  `;
  // Cambió de tipo: los valores que ya no encajan se convierten o se vacían.
  if (current && current.type !== type) await convertColumn(sql, ownerId, docId, field.id, type as FieldType);
  if (current?.type === "link" || type === "link") await syncTableLinks(sql, ownerId, docId);
  return { ok: true };
}

async function convertColumn(sql: Sql, ownerId: string, docId: string, fieldId: string, type: FieldType): Promise<void> {
  const rows = await sql<{ id: string; value: unknown }>`
    select id, cells -> ${fieldId}::text as value from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and not deleted and cells ? ${fieldId}::text
  `;
  const now = Date.now();
  for (const row of rows) {
    const raw = typeof row.value === "string" ? safeJson(row.value) : row.value;
    const value = cleanCell(type, Array.isArray(raw) && type !== "link" ? null : raw);
    await writeCell(sql, ownerId, docId, row.id, fieldId, value, null, now);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function deleteField(sql: Sql, ownerId: string, docId: string, fieldId: string): Promise<void> {
  const field = (await readFields(sql, ownerId, docId)).find((item) => item.id === fieldId);
  await sql`delete from data_field where owner_id = ${ownerId} and doc_id = ${docId} and id = ${fieldId}`;
  await sql`
    update data_row set cells = cells - ${fieldId}::text, updated_at = ${Date.now()}
    where owner_id = ${ownerId} and doc_id = ${docId} and cells ? ${fieldId}::text
  `;
  if (field?.type === "link") await syncTableLinks(sql, ownerId, docId);
}

/** Filas nuevas al final (o con sus valores, al importar). Devuelve las creadas. */
export async function addRows(
  sql: Sql,
  ownerId: string,
  docId: string,
  input: { cells: Record<string, unknown> }[],
  actor: string,
): Promise<{ ok: true; rows: TableRow[] } | { ok: false; error: string }> {
  const fields = await readFields(sql, ownerId, docId);
  const stats = await sql<{ count: unknown; last: unknown }>`
    select count(*) as count, coalesce(max(position), 0) as last from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and not deleted
  `;
  if (Number(stats[0]?.count ?? 0) + input.length > MAX_ROWS) return { ok: false, error: `Una tabla tiene como mucho ${MAX_ROWS} filas.` };
  let position = Number(stats[0]?.last ?? 0);
  const now = Date.now();
  const created: TableRow[] = [];
  for (const row of input) {
    const cells: Record<string, CellValue> = {};
    for (const field of fields) {
      const value = cleanCell(field.type, row.cells[field.id]);
      if (value !== null) cells[field.id] = value;
    }
    position += 1;
    const id = randomUUID();
    await sql`
      insert into data_row (owner_id, doc_id, id, position, cells, created_at, updated_at, updated_by)
      values (${ownerId}, ${docId}, ${id}, ${position}, ${JSON.stringify(cells)}::jsonb, ${now}, ${now}, ${actor})
    `;
    created.push({ id, position, cells, updatedAt: now, updatedBy: actor });
  }
  if (fields.some((field) => field.type === "link")) await syncTableLinks(sql, ownerId, docId);
  return { ok: true, rows: created };
}

async function writeCell(
  sql: Sql,
  ownerId: string,
  docId: string,
  rowId: string,
  fieldId: string,
  value: CellValue,
  actor: string | null,
  now: number,
): Promise<void> {
  // Solo esa celda: lo que otra persona cambió en otras celdas de la fila se queda.
  if (value === null) {
    await sql`
      update data_row set cells = cells - ${fieldId}::text, updated_at = ${now}, updated_by = coalesce(${actor}, updated_by)
      where owner_id = ${ownerId} and doc_id = ${docId} and id = ${rowId} and not deleted
    `;
    return;
  }
  await sql`
    update data_row set cells = cells || jsonb_build_object(${fieldId}::text, ${JSON.stringify(value)}::jsonb),
      updated_at = ${now}, updated_by = coalesce(${actor}, updated_by)
    where owner_id = ${ownerId} and doc_id = ${docId} and id = ${rowId} and not deleted
  `;
}

export async function updateCell(
  sql: Sql,
  ownerId: string,
  docId: string,
  input: { rowId: string; fieldId: string; value: unknown },
  actor: string,
): Promise<{ ok: true; row: TableRow } | { ok: false; error: string }> {
  const field = (await readFields(sql, ownerId, docId)).find((item) => item.id === input.fieldId);
  if (!field) return { ok: false, error: "Esa columna ya no existe." };
  const value = cleanCell(field.type, input.value);
  await writeCell(sql, ownerId, docId, input.rowId, input.fieldId, value, actor, Date.now());
  const rows = await sql<DataRow>`
    select id, position, cells, updated_at, updated_by from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and id = ${input.rowId} and not deleted limit 1
  `;
  if (!rows[0]) return { ok: false, error: "Esa fila ya no existe." };
  if (field.type === "link") await syncTableLinks(sql, ownerId, docId);
  return { ok: true, row: toRow(rows[0]) };
}

export async function deleteRows(sql: Sql, ownerId: string, docId: string, ids: string[], actor: string): Promise<void> {
  const now = Date.now();
  for (const id of ids) {
    await sql`
      update data_row set deleted = true, cells = '{}'::jsonb, updated_at = ${now}, updated_by = ${actor}
      where owner_id = ${ownerId} and doc_id = ${docId} and id = ${id} and not deleted
    `;
  }
  const fields = await readFields(sql, ownerId, docId);
  if (fields.some((field) => field.type === "link")) await syncTableLinks(sql, ownerId, docId);
}

/**
 * Lo que las celdas de vínculo señalan, como vínculos manuales del documento
 * de la tabla: así aparece en el grafo y en las menciones de cada nota,
 * archivo o portafolio, sin nada aparte. Con revisión nueva, para que lo vean
 * los navegadores al sincronizar y el índice de lo compartido.
 */
export async function syncTableLinks(sql: Sql, ownerId: string, docId: string): Promise<void> {
  const fields = (await readFields(sql, ownerId, docId)).filter((field) => field.type === "link");
  const refs = new Map<string, VaultRef>();
  if (fields.length) {
    const rows = await sql<{ cells: unknown }>`
      select cells from data_row where owner_id = ${ownerId} and doc_id = ${docId} and not deleted
    `;
    for (const row of rows) {
      const cells = (typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells) as Record<string, CellValue>;
      for (const field of fields) {
        const value = cells[field.id];
        if (Array.isArray(value)) for (const ref of value) refs.set(`${ref.kind}:${ref.id}`, ref);
      }
    }
  }
  const derived: ManualLink[] = [...refs.values()]
    .filter((ref) => ref.id !== docId)
    .map((ref) => ({ targetId: ref.id, kind: "referencia", ...(ref.kind === "portfolio" ? { target: "portfolio" as const } : {}) }));
  const current = await sql<{ links_json: string | null }>`
    select links_json from vault_doc where user_id = ${ownerId} and id = ${docId} limit 1
  `;
  if (!current[0]) return;
  const meta = await sql<{ derived_links: string }>`
    select derived_links from data_meta where owner_id = ${ownerId} and doc_id = ${docId} limit 1
  `;
  const key = (link: ManualLink) => `${link.target ?? "doc"}:${link.targetId}:${link.kind}:${link.anchor ? JSON.stringify(link.anchor) : ""}`;
  const before = new Set((safeJson(meta[0]?.derived_links ?? "[]") as ManualLink[]).map(key));
  // Los puestos a mano se quedan; los que salían de las celdas se cambian por los de ahora.
  const manual = (safeJson(current[0].links_json ?? "[]") as ManualLink[]).filter((link) => !before.has(key(link)));
  const merged = [...new Map([...manual, ...derived].map((link) => [key(link), link])).values()];
  await sql`
    insert into data_meta (owner_id, doc_id, derived_links) values (${ownerId}, ${docId}, ${JSON.stringify(derived)})
    on conflict (owner_id, doc_id) do update set derived_links = excluded.derived_links
  `;
  const next = JSON.stringify(merged);
  if ((current[0].links_json ?? "[]") === next) return;
  const rev = await nextRevision(sql, ownerId);
  await sql`update vault_doc set links_json = ${next}, rev = ${rev} where user_id = ${ownerId} and id = ${docId}`;
}
