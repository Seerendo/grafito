import type { Sql } from "@/lib/db";
import { DEFAULT_DESIGN, isDesign, type Design } from "@/domain/design";

/**
 * Diseño de la instalación (solo servidor), en `app_setting` con la clave
 * `ui_design`. Se lee en cada página que pinta el servidor, así que se guarda
 * unos segundos en memoria.
 */

const KEY = "ui_design";
const TTL_MS = 15_000;
let cached: { value: Design; at: number } | null = null;

export async function readDesign(sql: Sql): Promise<Design> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value: Design = DEFAULT_DESIGN;
  try {
    const rows = await sql<{ value: string }>`select value from app_setting where key = ${KEY} limit 1`;
    if (isDesign(rows[0]?.value)) value = rows[0].value;
  } catch {
    /* sin base todavía (primer arranque): el diseño por defecto */
  }
  cached = { value, at: Date.now() };
  return value;
}

export async function writeDesign(sql: Sql, design: Design): Promise<void> {
  await sql`
    insert into app_setting (key, value) values (${KEY}, ${design})
    on conflict (key) do update set value = excluded.value
  `;
  cached = { value: design, at: Date.now() };
}
