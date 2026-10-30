import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "@/lib/db";
import {
  cleanCell,
  cleanLayout,
  FIELD_TYPES,
  isPublicField,
  isRowRef,
  isTableName,
  isVaultRef,
  MAX_FIELDS,
  MAX_FORM_TEXT,
  MAX_ROWS,
  TABLE_MIME,
  emptyTableFile,
  type CellValue,
  type FieldType,
  type FormFieldView,
  type RowRef,
  type TableField,
  type TableForm,
  type TableLayout,
  type TableRow,
  type VaultRef,
} from "@/domain/vault/table";
import { computeFormulas, type FormulaValue } from "@/domain/vault/formula";
import { endFormLink, noteAccess, readTrail, retireExpired, type AccessHit, type GrantPeriod } from "@/server/access-trace";
import type { Document, ManualLink } from "@/domain/vault/types";
import { upsertElasticDoc } from "@/server/search";
import { VaultError, nextRevision, pushChanges } from "./vault";

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
  let options: { choices?: unknown; tableId?: unknown; formula?: unknown } = {};
  try {
    options = JSON.parse(row.options) as { choices?: unknown; tableId?: unknown; formula?: unknown };
  } catch {
    /* sin opciones */
  }
  const type = (FIELD_TYPES as readonly string[]).includes(row.type) ? (row.type as FieldType) : "text";
  const formula = typeof options.formula === "string" ? options.formula.slice(0, 500) : "";
  return {
    id: row.id,
    name: row.name,
    type,
    ...(Array.isArray(options.choices) ? { choices: options.choices.filter((choice): choice is string => typeof choice === "string") } : {}),
    ...(typeof options.tableId === "string" && options.tableId ? { relatedTableId: options.tableId } : {}),
    ...(type === "formula" ? { formula } : {}),
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
): Promise<{ fields: TableField[]; rows: TableRow[]; labels: Record<string, string>; form: TableForm | null; layout: TableLayout; at: number }> {
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
  const mapped = rows.map(toRow);
  await indexTable(sql, ownerId, docId);
  return { fields, rows: mapped, at, labels: await relationLabels(sql, ownerId, fields, mapped), form: await readForm(sql, ownerId, docId), layout: await readLayout(sql, ownerId, docId) };
}

/** Lo que cambió desde `since` (también las filas borradas), para ver lo de los demás sin recargar. */
export async function rowsSince(
  sql: Sql,
  ownerId: string,
  docId: string,
  since: number,
): Promise<{ rows: TableRow[]; deleted: string[]; fields: TableField[]; labels: Record<string, string>; at: number }> {
  const at = Date.now();
  const changed = await sql<DataRow>`
    select id, position, cells, updated_at, updated_by, deleted from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and updated_at > ${since}
    order by updated_at limit ${MAX_ROWS}
  `;
  const fields = await readFields(sql, ownerId, docId);
  const rows = changed.filter((row) => !flag(row.deleted)).map(toRow);
  return {
    rows,
    deleted: changed.filter((row) => flag(row.deleted)).map((row) => row.id),
    fields,
    labels: await relationLabels(sql, ownerId, fields, rows),
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
  const related = type === "relation" && field.relatedTableId ? field.relatedTableId.slice(0, 80) : undefined;
  const formula = type === "formula" ? (field.formula ?? "").trim().slice(0, 500) : undefined;
  const options = JSON.stringify({ ...(choices ? { choices } : {}), ...(related ? { tableId: related } : {}), ...(formula ? { formula } : {}) });
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
    values (${ownerId}, ${docId}, ${field.id}, ${name}, ${type}, ${options},
      ${Number(position ?? 0)}, ${field.width ?? null})
    on conflict (owner_id, doc_id, id) do update set
      name = excluded.name, type = excluded.type, options = excluded.options,
      position = coalesce(${field.position ?? null}, data_field.position), width = excluded.width
  `;
  // Cambió de tipo: los valores que ya no encajan se convierten o se vacían.
  if (current && current.type !== type) await convertColumn(sql, ownerId, docId, field.id, type as FieldType);
  const touchesLinks = (kind: string | undefined) => kind === "link" || kind === "file" || kind === "relation";
  if (touchesLinks(current?.type) || touchesLinks(type)) await syncTableLinks(sql, ownerId, docId);
  await indexTable(sql, ownerId, docId);
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
    const keepsRefs = type === "link" || type === "file" || type === "relation";
    const value = cleanCell(type, Array.isArray(raw) && !keepsRefs ? null : raw);
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
  if (field?.type === "link" || field?.type === "file" || field?.type === "relation") await syncTableLinks(sql, ownerId, docId);
  await indexTable(sql, ownerId, docId);
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
    await rememberRow(sql, ownerId, docId, id, actor, "create", diffCells({}, cells), now + created.length);
  }
  if (fields.some((field) => field.type === "link" || field.type === "file")) await syncTableLinks(sql, ownerId, docId);
  await indexTable(sql, ownerId, docId);
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
  if (field.type === "formula") return { ok: false, error: "Una fórmula se cambia en la columna, no en la celda." };
  const value = cleanCell(field.type, input.value);
  const before = await sql<{ cells: unknown }>`
    select cells from data_row where owner_id = ${ownerId} and doc_id = ${docId} and id = ${input.rowId} and not deleted limit 1
  `;
  if (!before[0]) return { ok: false, error: "Esa fila ya no existe." };
  const previous = cellMap(before[0].cells);
  const now = Date.now();
  await writeCell(sql, ownerId, docId, input.rowId, input.fieldId, value, actor, now);
  const rows = await sql<DataRow>`
    select id, position, cells, updated_at, updated_by from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and id = ${input.rowId} and not deleted limit 1
  `;
  if (!rows[0]) return { ok: false, error: "Esa fila ya no existe." };
  const after = toRow(rows[0]);
  if (JSON.stringify(previous[input.fieldId] ?? null) !== JSON.stringify(value)) {
    await rememberRow(sql, ownerId, docId, input.rowId, actor, "update", [{ fieldId: input.fieldId, from: previous[input.fieldId] ?? null, to: value }], now);
  }
  if (field.type === "link" || field.type === "file") await syncTableLinks(sql, ownerId, docId);
  await indexTable(sql, ownerId, docId);
  return { ok: true, row: after };
}

export async function deleteRows(sql: Sql, ownerId: string, docId: string, ids: string[], actor: string): Promise<void> {
  const now = Date.now();
  for (const id of ids) {
    const existing = await sql<{ cells: unknown }>`
      select cells from data_row where owner_id = ${ownerId} and doc_id = ${docId} and id = ${id} and not deleted limit 1
    `;
    if (!existing[0]) continue;
    const cells = cellMap(existing[0].cells);
    await sql`
      update data_row set deleted = true, cells = '{}'::jsonb, updated_at = ${now}, updated_by = ${actor}
      where owner_id = ${ownerId} and doc_id = ${docId} and id = ${id} and not deleted
    `;
    await rememberRow(sql, ownerId, docId, id, actor, "delete", diffCells(cells, {}), now);
  }
  const fields = await readFields(sql, ownerId, docId);
  if (fields.some((field) => field.type === "link" || field.type === "file")) await syncTableLinks(sql, ownerId, docId);
  await indexTable(sql, ownerId, docId);
}

/**
 * Lo que las celdas de vínculo señalan, como vínculos manuales del documento
 * de la tabla: así aparece en el grafo y en las menciones de cada nota,
 * archivo o portafolio, sin nada aparte. Con revisión nueva, para que lo vean
 * los navegadores al sincronizar y el índice de lo compartido.
 */
export async function syncTableLinks(sql: Sql, ownerId: string, docId: string): Promise<void> {
  const fields = await readFields(sql, ownerId, docId);
  const linked = fields.filter((field) => field.type === "link" || field.type === "file");
  const refs = new Map<string, VaultRef>();
  for (const field of fields) {
    if (field.type === "relation" && field.relatedTableId && field.relatedTableId !== docId) {
      refs.set(`document:${field.relatedTableId}`, { id: field.relatedTableId, kind: "document" });
    }
  }
  if (linked.length) {
    const rows = await sql<{ cells: unknown }>`
      select cells from data_row where owner_id = ${ownerId} and doc_id = ${docId} and not deleted
    `;
    for (const row of rows) {
      const cells = (typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells) as Record<string, CellValue>;
      for (const field of linked) {
        const value = cells[field.id];
        if (Array.isArray(value)) for (const ref of value) if (isVaultRef(ref)) refs.set(`${ref.kind}:${ref.id}`, ref);
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

function rowKey(ref: RowRef): string {
  return `${ref.tableId}:${ref.rowId}`;
}

/** Etiquetas de las filas que señalan las celdas de relación (la primera columna de texto). */
export async function relationLabels(sql: Sql, ownerId: string, fields: TableField[], rows: TableRow[]): Promise<Record<string, string>> {
  const wanted = new Map<string, Set<string>>();
  for (const field of fields) {
    if (field.type !== "relation") continue;
    for (const row of rows) {
      const value = row.cells[field.id];
      if (!Array.isArray(value)) continue;
      for (const ref of value) {
        if (!isRowRef(ref)) continue;
        const ids = wanted.get(ref.tableId) ?? new Set<string>();
        ids.add(ref.rowId);
        wanted.set(ref.tableId, ids);
      }
    }
  }
  const labels: Record<string, string> = {};
  for (const [tableId, ids] of wanted) {
    const targetFields = await readFields(sql, ownerId, tableId);
    const labelField = targetFields.find((field) => field.type === "text" || field.type === "select") ?? targetFields[0];
    const separator = "\u001f";
    const found = await sql<{ id: string; cells: unknown }>`
      select id, cells from data_row
      where owner_id = ${ownerId} and doc_id = ${tableId} and not deleted
        and id = any(string_to_array(${[...ids].join(separator)}, ${separator}))
    `;
    for (const row of found) {
      const cells = (typeof row.cells === "string" ? safeJson(row.cells) : row.cells) as Record<string, CellValue>;
      const raw = labelField ? cells?.[labelField.id] : null;
      const label = raw === null || raw === undefined || Array.isArray(raw) ? "" : String(raw);
      labels[rowKey({ tableId, rowId: row.id })] = label || "Fila";
    }
  }
  return labels;
}

/** Filas de una tabla, para el selector de una relación (como mucho 200). */
export async function rowChoices(
  sql: Sql,
  ownerId: string,
  tableId: string,
  query: string,
): Promise<{ id: string; label: string }[]> {
  const fields = await readFields(sql, ownerId, tableId);
  const labelField = fields.find((field) => field.type === "text" || field.type === "select") ?? fields[0];
  const rows = await sql<{ id: string; cells: unknown }>`
    select id, cells from data_row
    where owner_id = ${ownerId} and doc_id = ${tableId} and not deleted
    order by position limit 200
  `;
  const needle = query.trim().toLowerCase();
  const choices: { id: string; label: string }[] = [];
  for (const row of rows) {
    const cells = (typeof row.cells === "string" ? safeJson(row.cells) : row.cells) as Record<string, CellValue>;
    const raw = labelField ? cells?.[labelField.id] : null;
    const label = raw === null || raw === undefined || Array.isArray(raw) ? "" : String(raw);
    const text = label || "Fila";
    if (needle && !text.toLowerCase().includes(needle)) continue;
    choices.push({ id: row.id, label: text });
    if (choices.length >= 40) break;
  }
  return choices;
}

/** Texto de las celdas, para la búsqueda de la bóveda y Elasticsearch. */
export async function indexTable(sql: Sql, ownerId: string, docId: string): Promise<void> {
  const fields = await readFields(sql, ownerId, docId);
  const rows = await sql<{ cells: unknown }>`
    select cells from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and not deleted
    order by position limit 2000
  `;
  const parts: string[] = [];
  for (const row of rows) {
    const cells = (typeof row.cells === "string" ? safeJson(row.cells) : row.cells) as Record<string, CellValue>;
    const computed = computeFormulas(fields, cells ?? {});
    for (const field of fields) {
      const value = field.type === "formula" ? computed.values[field.id] : cells?.[field.id];
      if (value === null || value === undefined || Array.isArray(value) || value === false) continue;
      const text = String(value).trim();
      if (text) parts.push(text);
    }
  }
  const search = parts.join("\n").slice(0, 8000);
  await sql`
    insert into data_meta (owner_id, doc_id, derived_links, search_text)
    values (${ownerId}, ${docId}, '[]', ${search})
    on conflict (owner_id, doc_id) do update set search_text = excluded.search_text
  `;
  const doc = await sql<{ title: string; kind: string; portfolio_id: string | null }>`
    select title, kind, portfolio_id from vault_doc where user_id = ${ownerId} and id = ${docId} and not deleted limit 1
  `;
  if (!doc[0]) return;
  await sql`
    insert into doc_index (user_id, doc_id, title, kind, portfolio_id, body, links_json, updated_at)
    values (${ownerId}, ${docId}, ${doc[0].title}, ${doc[0].kind}, ${doc[0].portfolio_id}, ${search}, '[]', now())
    on conflict (user_id, doc_id) do update set body = excluded.body, title = excluded.title, updated_at = now()
  `;
  await upsertElasticDoc(ownerId, {
    id: docId,
    title: doc[0].title,
    kind: doc[0].kind,
    portfolioId: doc[0].portfolio_id,
    body: search,
    links: [],
  });
}

/** Textos ya indexados, para la búsqueda del navegador (la barra y la paleta). */
export async function tableDigests(sql: Sql, ownerId: string): Promise<Record<string, string>> {
  const rows = await sql<{ doc_id: string; search_text: string }>`
    select m.doc_id, m.search_text from data_meta m
    join vault_doc d on d.user_id = m.owner_id and d.id = m.doc_id and not d.deleted
    where m.owner_id = ${ownerId} and m.search_text <> ''
    limit 300
  `;
  return Object.fromEntries(rows.map((row) => [row.doc_id, row.search_text.slice(0, 4000)]));
}

export async function readForm(sql: Sql, ownerId: string, docId: string): Promise<TableForm | null> {
  const rows = await sql<{
    title: string;
    description: string;
    fields: string;
    public_token: string | null;
    enabled: unknown;
    opened_at: unknown;
    expires_at: unknown;
    revoked_at: unknown;
  }>`
    select title, description, fields, public_token, enabled, opened_at, expires_at, revoked_at from data_form
    where owner_id = ${ownerId} and doc_id = ${docId} limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  let fields: { id: string; required: boolean }[] = [];
  try {
    const parsed = JSON.parse(row.fields) as { id?: unknown; required?: unknown }[];
    if (Array.isArray(parsed)) {
      fields = parsed
        .filter((item) => item && typeof item.id === "string")
        .map((item) => ({ id: item.id as string, required: Boolean(item.required) }))
        .slice(0, MAX_FIELDS);
    }
  } catch {
    /* sin columnas */
  }
  const stamp = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return {
    title: row.title,
    description: row.description,
    fields,
    publicToken: row.public_token,
    enabled: flag(row.enabled),
    openedAt: stamp(row.opened_at),
    expiresAt: stamp(row.expires_at),
    revokedAt: stamp(row.revoked_at),
  };
}

export async function saveForm(
  sql: Sql,
  ownerId: string,
  docId: string,
  input: { title: string; description: string; fields: { id: string; required: boolean }[]; publish: boolean; expiresAt?: number | null },
  endedBy = "",
): Promise<{ ok: true; form: TableForm } | { ok: false; error: string }> {
  const known = new Set((await readFields(sql, ownerId, docId)).map((field) => field.id));
  const fields = input.fields.filter((field) => known.has(field.id)).slice(0, MAX_FIELDS);
  if (fields.length === 0) return { ok: false, error: "El formulario necesita al menos una columna." };
  const title = input.title.trim().slice(0, 160) || "Formulario";
  const description = input.description.trim().slice(0, MAX_FORM_TEXT);
  const current = await readForm(sql, ownerId, docId);
  const now = Date.now();
  let token = current?.publicToken ?? null;
  let openedAt = current?.openedAt ?? null;
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : (current?.expiresAt ?? null);
  let revokedAt = current?.revokedAt ?? null;
  if (input.publish) {
    if (!token || revokedAt) {
      token = randomBytes(16).toString("hex");
      openedAt = now;
      revokedAt = null;
    }
  } else if (token && current?.enabled) {
    await endFormLink(sql, { ownerId, docId, title: current.title, grantedAt: openedAt, expiresAt: current.expiresAt ?? null, endedBy });
    token = null;
    revokedAt = now;
  }
  await sql`
    insert into data_form (owner_id, doc_id, title, description, fields, public_token, enabled, opened_at, expires_at, revoked_at)
    values (${ownerId}, ${docId}, ${title}, ${description}, ${JSON.stringify(fields)}, ${token}, ${input.publish}, ${openedAt}, ${expiresAt}, ${revokedAt})
    on conflict (owner_id, doc_id) do update set
      title = excluded.title, description = excluded.description, fields = excluded.fields,
      public_token = excluded.public_token, enabled = excluded.enabled,
      opened_at = excluded.opened_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at
  `;
  const form = await readForm(sql, ownerId, docId);
  return form ? { ok: true, form } : { ok: false, error: "No se pudo guardar el formulario." };
}

/** Deja el enlace del formulario inservible. */
export async function revokeFormLink(sql: Sql, ownerId: string, docId: string, endedBy: string): Promise<TableForm | null> {
  const current = await readForm(sql, ownerId, docId);
  if (!current?.publicToken) return null;
  await endFormLink(sql, {
    ownerId,
    docId,
    title: current.title,
    grantedAt: current.openedAt ?? null,
    expiresAt: current.expiresAt ?? null,
    endedBy,
  });
  await sql`
    update data_form set enabled = false, public_token = null, revoked_at = ${Date.now()}
    where owner_id = ${ownerId} and doc_id = ${docId}
  `;
  return readForm(sql, ownerId, docId);
}

export async function formActivity(
  sql: Sql,
  ownerId: string,
  docId: string,
): Promise<{ periods: GrantPeriod[]; events: AccessHit[] }> {
  await retireExpired(sql);
  const trail = await readTrail(sql, ownerId, "form", docId);
  const current = await readForm(sql, ownerId, docId);
  const open =
    current?.enabled && current.publicToken
      ? [
          {
            subjectKind: "link" as const,
            subjectId: "",
            subjectName: current.title,
            grantedAt: current.openedAt ?? 0,
            expiresAt: current.expiresAt ?? null,
            endedAt: null,
            endKind: "" as const,
          },
        ]
      : [];
  return { periods: [...open, ...trail.periods], events: trail.events };
}

async function formByToken(sql: Sql, token: string) {
  await retireExpired(sql);
  const rows = await sql<{ owner_id: string; doc_id: string; title: string; description: string; fields: string; enabled: unknown }>`
    select f.owner_id, f.doc_id, f.title, f.description, f.fields, f.enabled
    from data_form f
    join vault_doc d on d.user_id = f.owner_id and d.id = f.doc_id and not d.deleted
    where f.public_token = ${token} and f.enabled and f.revoked_at is null
      and (f.expires_at is null or f.expires_at > ${Date.now()})
    limit 1
  `;
  return rows[0] ?? null;
}

function formFields(raw: string, columns: TableField[], publicOnly: boolean): FormFieldView[] {
  let listed: { id: string; required: boolean }[] = [];
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; required?: unknown }[];
    if (Array.isArray(parsed)) {
      listed = parsed.filter((item) => item && typeof item.id === "string").map((item) => ({ id: item.id as string, required: Boolean(item.required) }));
    }
  } catch {
    listed = [];
  }
  const byId = new Map(columns.map((field) => [field.id, field]));
  return listed.flatMap((item) => {
    const field = byId.get(item.id);
    if (!field) return [];
    if (publicOnly && !isPublicField(field.type)) return [];
    return [
      {
        id: field.id,
        name: field.name,
        type: field.type,
        ...(field.choices ? { choices: field.choices } : {}),
        required: item.required,
        ...(field.relatedTableId ? { relatedTableId: field.relatedTableId } : {}),
      },
    ];
  });
}

function shownOnPublic(field: FormFieldView): boolean {
  return isPublicField(field.type) || field.type === "file";
}

/** Lo que ve quien abre el enlace, sin ninguna fila. */
export async function publicFormView(
  sql: Sql,
  token: string,
): Promise<{ ok: true; title: string; description: string; fields: FormFieldView[] } | { ok: false; error: string }> {
  const form = await formByToken(sql, token);
  if (!form || !flag(form.enabled)) return { ok: false, error: "Este formulario no está disponible." };
  await noteAccess(sql, {
    ownerId: form.owner_id,
    formDocId: form.doc_id,
    channel: "form",
    actorId: "view",
    actorName: "Alguien abrió el formulario",
  }).catch(() => undefined);
  const fields = formFields(form.fields, await readFields(sql, form.owner_id, form.doc_id), false).filter(shownOnPublic);
  return { ok: true, title: form.title, description: form.description, fields };
}

/** Añade una fila desde el enlace público. No devuelve el resto de la tabla. */
export async function submitPublicForm(
  sql: Sql,
  token: string,
  cells: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const form = await formByToken(sql, token);
  if (!form || !flag(form.enabled)) return { ok: false, error: "Este formulario no está disponible." };
  const fields = formFields(form.fields, await readFields(sql, form.owner_id, form.doc_id), false).filter(shownOnPublic);
  const clean: Record<string, unknown> = {};
  for (const field of fields) {
    const value = cleanCell(field.type, cells[field.id]);
    if (field.required && (value === null || value === false)) return { ok: false, error: `Falta «${field.name}».` };
    if (value !== null) clean[field.id] = value;
  }
  const created = await addRows(sql, form.owner_id, form.doc_id, [{ cells: clean }], "Formulario público");
  if (created.ok) {
    await noteAccess(sql, {
      ownerId: form.owner_id,
      formDocId: form.doc_id,
      channel: "form",
      actorId: "submit",
      actorName: "Alguien envió el formulario",
    }).catch(() => undefined);
  }
  return created.ok ? { ok: true } : created;
}

/**
 * Crea el archivo de un adjunto ya subido (su clave) como documento de la
 * bóveda, en el mismo portafolio que la tabla, y devuelve su id.
 */
export async function attachFile(
  sql: Sql,
  ownerId: string,
  docId: string,
  input: { name: string; mime: string; key: string; size: number; actor: string },
): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> {
  const { ownsKey } = await import("./files");
  const { checkSpace } = await import("./space");
  if (!ownsKey(ownerId, input.key)) return { ok: false, error: "Ese archivo no es de esta bóveda." };
  const docs = await sql<{ portfolio_id: string | null; title: string }>`
    select portfolio_id, title from vault_doc where user_id = ${ownerId} and id = ${docId} and not deleted limit 1
  `;
  if (!docs[0]) return { ok: false, error: "Esa tabla ya no existe." };
  const full = await checkSpace(sql, { ownerId, portfolioId: docs[0].portfolio_id, uploaderId: ownerId, bytes: input.size });
  if (full) return { ok: false, error: full };
  const now = Date.now();
  const base = input.name.replace(/\.[^.]+$/, "").trim().slice(0, 200) || input.name.slice(0, 200) || "Archivo";
  const file: Document = {
    id: randomUUID(),
    title: base,
    portfolioId: docs[0].portfolio_id,
    kind: "file",
    content: "",
    file: { name: input.name.slice(0, 200), mime: input.mime.slice(0, 120) || "application/octet-stream", key: input.key, size: input.size },
    links: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    createdBy: input.actor,
    updatedBy: input.actor,
  };
  await pushChanges(sql, ownerId, { docs: [file], deletedDocs: [], portfolios: [], deletedPortfolios: [] });
  return { ok: true, id: file.id, title: file.title };
}

/** Filas para la IA: columnas por nombre, como mucho `limit`. */
export async function queryRows(
  sql: Sql,
  ownerId: string,
  docId: string,
  query: string,
  limit: number,
): Promise<{ fields: string[]; rows: Record<string, string>[] } | null> {
  const fields = await readFields(sql, ownerId, docId);
  if (fields.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const rows = await sql<DataRow>`
    select id, position, cells, updated_at, updated_by from data_row
    where owner_id = ${ownerId} and doc_id = ${docId} and not deleted
    order by position limit ${MAX_ROWS}
  `;
  const matched: Record<string, string>[] = [];
  for (const row of rows.map(toRow)) {
    const record: Record<string, string> = { id: row.id };
    const blob: string[] = [];
    const computed = computeFormulas(fields, row.cells);
    for (const field of fields) {
      const value = field.type === "formula" ? computed.values[field.id] : row.cells[field.id];
      const text = value === null || value === undefined || Array.isArray(value) || value === false ? "" : String(value);
      record[field.name] = text;
      if (text) blob.push(text);
    }
    if (needle && !blob.join("\n").toLowerCase().includes(needle)) continue;
    matched.push(record);
    if (matched.length >= limit) break;
  }
  return { fields: fields.map((field) => field.name), rows: matched };
}

/** Una fila nueva a partir de valores nombrados por columna (la IA y los formularios internos). */
export async function addNamedRow(
  sql: Sql,
  ownerId: string,
  docId: string,
  named: Record<string, unknown>,
  actor: string,
): Promise<{ ok: true; row: TableRow } | { ok: false; error: string }> {
  const fields = await readFields(sql, ownerId, docId);
  if (fields.length === 0) return { ok: false, error: "Esa tabla no tiene columnas." };
  const cells: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(named)) {
    const field = fields.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase() || item.id === name);
    if (field) cells[field.id] = value;
  }
  const created = await addRows(sql, ownerId, docId, [{ cells }], actor);
  if (!created.ok) return created;
  const row = created.rows[0];
  return row ? { ok: true, row } : { ok: false, error: "No se pudo añadir la fila." };
}

/** Adjunto de un formulario público: el archivo entra en la bóveda del dueño. */
export async function attachPublicFile(
  sql: Sql,
  token: string,
  input: { name: string; mime: string; base64: string },
): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> {
  const form = await formByToken(sql, token);
  if (!form || !flag(form.enabled)) return { ok: false, error: "Este formulario no está disponible." };
  const columns = formFields(form.fields, await readFields(sql, form.owner_id, form.doc_id), false);
  if (!columns.some((field) => field.type === "file")) return { ok: false, error: "Este formulario no admite archivos." };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.base64, "base64");
  } catch {
    return { ok: false, error: "El archivo no se pudo leer." };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 6 * 1024 * 1024) return { ok: false, error: "El archivo debe pesar entre 1 byte y 6 MB." };
  const { newFileKey } = await import("./files");
  const { putBlob } = await import("./blobs");
  const key = newFileKey(form.owner_id);
  await putBlob(sql, key, bytes, input.mime || "application/octet-stream");
  return attachFile(sql, form.owner_id, form.doc_id, {
    name: input.name,
    mime: input.mime || "application/octet-stream",
    key,
    size: bytes.byteLength,
    actor: "Formulario público",
  });
}

// ---------------------------------------------------------------------------
// Fase 3: vista, historial y lo que usa la API REST.

const MAX_HISTORY = 40;

type StoredChange = { fieldId: string; from: CellValue; to: CellValue };

export type HistoryEntry = {
  id: string;
  at: number;
  actor: string;
  kind: "create" | "update" | "delete";
  changes: { field: string; from: string; to: string }[];
};

function cellMap(raw: unknown): Record<string, CellValue> {
  const cells = typeof raw === "string" ? safeJson(raw) : raw;
  return cells && typeof cells === "object" && !Array.isArray(cells) ? (cells as Record<string, CellValue>) : {};
}

function diffCells(before: Record<string, CellValue>, after: Record<string, CellValue>): StoredChange[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: StoredChange[] = [];
  for (const fieldId of ids) {
    const from = before[fieldId] ?? null;
    const to = after[fieldId] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ fieldId, from, to });
  }
  return changes;
}

function historyText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (Array.isArray(value)) return value.length ? String(value.length) : "";
  return String(value);
}

/** Deja constancia de un cambio de fila y se queda con las últimas `MAX_HISTORY`. */
async function rememberRow(
  sql: Sql,
  ownerId: string,
  docId: string,
  rowId: string,
  actor: string,
  kind: HistoryEntry["kind"],
  changes: StoredChange[],
  at: number,
): Promise<void> {
  await sql`
    insert into data_row_history (owner_id, doc_id, id, row_id, at, actor, kind, changes)
    values (${ownerId}, ${docId}, ${randomUUID()}, ${rowId}, ${at}, ${actor}, ${kind}, ${JSON.stringify(changes)}::jsonb)
  `;
  const extra = await sql<{ id: string }>`
    select id from data_row_history
    where owner_id = ${ownerId} and doc_id = ${docId} and row_id = ${rowId}
    order by at desc offset ${MAX_HISTORY}
  `;
  for (const row of extra) {
    await sql`delete from data_row_history where owner_id = ${ownerId} and doc_id = ${docId} and id = ${row.id}`;
  }
}

export async function readLayout(sql: Sql, ownerId: string, docId: string): Promise<TableLayout> {
  const rows = await sql<{ layout: string | null }>`
    select layout from data_meta where owner_id = ${ownerId} and doc_id = ${docId} limit 1
  `;
  if (!rows[0]?.layout) return cleanLayout(null);
  try {
    return cleanLayout(JSON.parse(rows[0].layout));
  } catch {
    return cleanLayout(null);
  }
}

export async function saveLayout(
  sql: Sql,
  ownerId: string,
  docId: string,
  input: TableLayout,
): Promise<{ ok: true; layout: TableLayout }> {
  const layout = cleanLayout(input);
  await sql`
    insert into data_meta (owner_id, doc_id, derived_links, layout)
    values (${ownerId}, ${docId}, '[]', ${JSON.stringify(layout)})
    on conflict (owner_id, doc_id) do update set layout = excluded.layout
  `;
  return { ok: true, layout };
}

/** Los últimos cambios de una fila, del más reciente al más antiguo. */
export async function rowHistory(sql: Sql, ownerId: string, docId: string, rowId: string): Promise<HistoryEntry[]> {
  const fields = await readFields(sql, ownerId, docId);
  const rows = await sql<{ id: string; at: unknown; actor: string; kind: string; changes: unknown }>`
    select id, at, actor, kind, changes from data_row_history
    where owner_id = ${ownerId} and doc_id = ${docId} and row_id = ${rowId}
    order by at desc limit ${MAX_HISTORY}
  `;
  return rows.map((row) => {
    const raw = (typeof row.changes === "string" ? safeJson(row.changes) : row.changes) as { fieldId?: string; from?: CellValue; to?: CellValue }[];
    const changes = (Array.isArray(raw) ? raw : []).map((change) => {
      const field = fields.find((item) => item.id === change.fieldId);
      return { field: field?.name ?? "Columna", from: historyText(change.from ?? null), to: historyText(change.to ?? null) };
    });
    const kind = row.kind === "create" || row.kind === "delete" ? row.kind : "update";
    return { id: row.id, at: Number(row.at), actor: row.actor, kind, changes };
  });
}

export function presentField(field: TableField) {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    position: field.position,
    ...(field.choices ? { choices: field.choices } : {}),
    ...(field.relatedTableId ? { relatedTableId: field.relatedTableId } : {}),
    ...(field.type === "formula" ? { formula: field.formula ?? "" } : {}),
  };
}

/** Una fila como la ve la API: celdas por nombre de columna y fórmulas ya calculadas. */
export function presentRow(fields: TableField[], row: TableRow) {
  const computed = computeFormulas(fields, row.cells);
  const cells: Record<string, CellValue> = {};
  const formulas: Record<string, FormulaValue> = {};
  for (const field of fields) {
    if (field.type === "formula") {
      formulas[field.name] = computed.values[field.id] ?? null;
      continue;
    }
    const value = row.cells[field.id];
    if (value !== undefined && value !== null) cells[field.name] = value;
  }
  return { id: row.id, cells, formulas, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

export async function listTables(
  sql: Sql,
  userId: string,
): Promise<{ id: string; title: string; portfolioId: string | null; updatedAt: number }[]> {
  const rows = await sql<{ id: string; title: string; portfolio_id: string | null; updated_at: unknown }>`
    select id, title, portfolio_id, updated_at from vault_doc
    where user_id = ${userId} and not deleted and kind = 'file' and file_name ilike '%.tabla'
    order by updated_at desc limit 500
  `;
  return rows.map((row) => ({ id: row.id, title: row.title, portfolioId: row.portfolio_id, updatedAt: Number(row.updated_at) }));
}

/** El documento, si es una tabla de este dueño. */
export async function tableDocument(sql: Sql, userId: string, docId: string): Promise<{ title: string } | null> {
  const rows = await sql<{ title: string; file_name: string | null }>`
    select title, file_name from vault_doc where user_id = ${userId} and id = ${docId} and not deleted limit 1
  `;
  if (!rows[0] || !isTableName(rows[0].file_name ?? "")) return null;
  return { title: rows[0].title };
}

/** Crea el archivo `.tabla` en la bóveda. Las columnas nacen al leerla. */
export async function createTable(
  sql: Sql,
  userId: string,
  input: { title: string; portfolioId: string | null; actor: string },
): Promise<{ id: string; title: string }> {
  if (input.portfolioId) {
    const found = await sql<{ id: string }>`
      select id from vault_portfolio where user_id = ${userId} and id = ${input.portfolioId} and not deleted limit 1
    `;
    if (!found[0]) throw new VaultError("Ese portafolio no existe.", 404);
  }
  const title = input.title.trim().replace(/\.tabla$/i, "").replace(/[\\/]/g, " ").replace(/\s+/g, " ").slice(0, 180) || "Tabla";
  const bytes = Buffer.from(emptyTableFile(), "utf8");
  const { checkSpace } = await import("./space");
  const full = await checkSpace(sql, { ownerId: userId, portfolioId: input.portfolioId, uploaderId: userId, bytes: bytes.byteLength });
  if (full) throw new VaultError(full, 413);
  const { newFileKey } = await import("./files");
  const { putBlob } = await import("./blobs");
  const key = newFileKey(userId);
  await putBlob(sql, key, bytes, TABLE_MIME);
  const now = Date.now();
  const doc: Document = {
    id: randomUUID(),
    title,
    portfolioId: input.portfolioId,
    kind: "file",
    content: "",
    file: { name: `${title}.tabla`, mime: TABLE_MIME, key, size: bytes.byteLength },
    links: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    createdBy: input.actor,
    updatedBy: input.actor,
  };
  await pushChanges(sql, userId, { docs: [doc], deletedDocs: [], portfolios: [], deletedPortfolios: [] });
  return { id: doc.id, title };
}

/** Cambia celdas nombradas por columna. Las fórmulas se rechazan. */
export async function patchNamedCells(
  sql: Sql,
  ownerId: string,
  docId: string,
  rowId: string,
  named: Record<string, unknown>,
  actor: string,
): Promise<{ ok: true; row: TableRow } | { ok: false; error: string }> {
  const fields = await readFields(sql, ownerId, docId);
  const names = Object.entries(named);
  if (names.length === 0) return { ok: false, error: "Nada que cambiar." };
  let last: TableRow | null = null;
  for (const [name, value] of names) {
    const field = fields.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase() || item.id === name);
    if (!field) return { ok: false, error: `No existe la columna «${name}».` };
    if (field.type === "formula") return { ok: false, error: `«${field.name}» es una fórmula.` };
    const saved = await updateCell(sql, ownerId, docId, { rowId, fieldId: field.id, value }, actor);
    if (!saved.ok) return saved;
    last = saved.row;
  }
  return last ? { ok: true, row: last } : { ok: false, error: "Esa fila ya no existe." };
}


