import type { Sql } from "@/lib/db";

/**
 * claimJob reserves a named periodic task in app_setting until now+ttlMs. Only the successful
 * claimant runs that pass. Works with Postgres and PGLite.
 */
export async function claimJob(
  sql: Sql,
  name: string,
  ttlMs: number,
  now = Date.now(),
): Promise<boolean> {
  const rows = await sql<{ key: string }>`
    insert into app_setting (key, value) values (${`job:${name}`}, ${String(now + ttlMs)})
    on conflict (key) do update set value = excluded.value
      where app_setting.value::bigint <= ${now}
    returning key
  `;
  return rows.length > 0;
}
