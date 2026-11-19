import { NO_RULES, parseRules, type ExtensionRules } from "@/domain/file-extensions";
import type { Sql } from "@/lib/db";

/** Extension rules live in app_setting as comma-separated lists; see domain/file-extensions.ts. */

const KEYS = { upload: "upload_blocked_ext", index: "index_blocked_ext" } as const;

export async function readExtensionRules(sql: Sql): Promise<ExtensionRules> {
  const rows = await sql<{ key: string; value: string }>`
    select key, value from app_setting where key in (${KEYS.upload}, ${KEYS.index})
  `;
  if (rows.length === 0) return NO_RULES;
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return parseRules(map.get(KEYS.upload) ?? "", map.get(KEYS.index) ?? "");
}

export async function writeExtensionRules(sql: Sql, rules: ExtensionRules): Promise<void> {
  const pairs: [string, string][] = [
    [KEYS.upload, rules.upload.join(",")],
    [KEYS.index, rules.index.join(",")],
  ];
  for (const [key, value] of pairs) {
    await sql`
      insert into app_setting (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value
    `;
  }
}
