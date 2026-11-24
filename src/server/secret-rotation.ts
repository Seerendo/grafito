import type { Sql } from "@/lib/db";
import { encrypt, open, retirePublicPrevious } from "./crypto";

/**
 * Re-encrypt stored secrets (Git tokens, the SMTP password) that still open only with
 * the previous key, then stop accepting the public example as previous key: anything sealed
 * with it could be read by anyone who knows the example (security finding GRAF-05). Runs once
 * per process; the example comes back as previous key on the next start only until nothing
 * sealed with it is left, which this pass ensures.
 */

let started: Promise<void> | null = null;

export function rotateSealedSecrets(sql: Sql): Promise<void> {
  started ??= (async () => {
    try {
      await rotate(sql);
      retirePublicPrevious();
    } catch (error) {
      console.error("[grafito] No se pudieron volver a cifrar los secretos guardados.", error);
    }
  })();
  return started;
}

function reseal(sealed: string): string | null {
  if (!sealed) return null;
  try {
    const opened = open(sealed);
    return opened.stale ? encrypt(opened.value) : null;
  } catch {
    // Unreadable with either key: leave it; the screen that uses it asks for it again.
    return null;
  }
}

async function rotate(sql: Sql): Promise<void> {
  const links = await sql<{ id: string; token: string }>`select id, token from git_link`;
  for (const row of links) {
    const next = reseal(row.token);
    if (next) await sql`update git_link set token = ${next} where id = ${row.id}`;
  }
  const mail = await sql<{ value: string }>`
    select value from app_setting where key = 'mail_password' limit 1
  `;
  const next = mail[0] ? reseal(mail[0].value) : null;
  if (next) await sql`update app_setting set value = ${next} where key = 'mail_password'`;
}
