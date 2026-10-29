import type { Sql } from "@/lib/db";

/**
 * Tareas periódicas con varias instancias de Grafito: solo una las corre en
 * cada vuelta. `claimJob` reserva la tarea `name` durante `ttlMs` (una fila de
 * `app_setting` con la hora hasta la que queda reservada) y dice si la
 * consiguió esta instancia. Sirve igual con Postgres que con PGLite.
 */
export async function claimJob(sql: Sql, name: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const rows = await sql<{ key: string }>`
    insert into app_setting (key, value) values (${`job:${name}`}, ${String(now + ttlMs)})
    on conflict (key) do update set value = excluded.value
      where app_setting.value::bigint <= ${now}
    returning key
  `;
  return rows.length > 0;
}
