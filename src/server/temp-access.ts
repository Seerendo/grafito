import { randomInt } from "node:crypto";
import type { Sql } from "@/lib/db";
import type { Locale } from "@/domain/i18n";
import { accessMail, mailReady, readMailSettings, sendMail } from "./mail";
import { createNote, dropNote } from "./secret-note";

/**
 * Initial email access uses a random temporary password, hashed in Better Auth and revealed
 * only through an encrypted one-time note. It expires after mail_access_hours, permits one
 * sign-in and requires replacement. Delete temporary-access state after password change; see
 * docs/MAIL.md.
 */

/**
 * Avoid ambiguous characters. Sixteen characters from fifty-six possibilities provide
 * approximately ninety-three bits.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const LENGTH = 16;

export function temporaryPassword(): string {
  let value = "";
  for (let index = 0; index < LENGTH; index += 1) value += ALPHABET[randomInt(ALPHABET.length)];
  return value;
}

export type AccessResult =
  | { ok: true; mailed: true; expiresAt: number }
  | { ok: true; mailed: false; link: string; expiresAt: number; reason: string };

/**
 * Issue a temporary password and email access. If mail is unavailable or fails, return a link
 * for administrator delivery so offline installations remain usable.
 */
export async function issueAccess(
  sql: Sql,
  userId: string,
  options: { resent: boolean },
): Promise<AccessResult> {
  const settings = await readMailSettings(sql);
  const person = await sql<{
    name: string;
    login_name: string | null;
    contact_email: string | null;
    locale: string | null;
  }>`
    select u.name, m.login_name, p.contact_email, p.locale
    from "user" u
    left join app_user_role m on m.user_id = u.id
    left join app_profile p on p.user_id = u.id
    where u.id = ${userId}
    limit 1
  `;
  const row = person[0];
  if (!row) throw new Error("Ese usuario no está.");
  const now = Date.now();
  const expiresAt = now + settings.accessHours * 3_600_000;
  const password = temporaryPassword();
  const { hashPassword } = await import("better-auth/crypto");
  const hashed = await hashPassword(password);
  await sql`
    update "account" set password = ${hashed}, "updatedAt" = now()
    where "userId" = ${userId} and "providerId" = 'credential'
  `;
  // Invalidate previous access note, sessions and password.
  const previous = await sql<{
    note_id: string | null;
  }>`select note_id from app_temp_access where user_id = ${userId}`;
  if (previous[0]?.note_id) await dropNote(sql, previous[0].note_id);
  if (options.resent) await sql`delete from "session" where "userId" = ${userId}`;
  // The secret note contains the username and temporary password needed for sign-in.
  const note = await createNote(
    sql,
    JSON.stringify({ password, login: row.login_name ?? "", expiresAt }),
    expiresAt,
  );
  await sql`
    insert into app_temp_access (user_id, expires_at, used_at, note_id, password_hash, created_at)
    values (${userId}, ${expiresAt}, null, ${note.id}, ${hashed}, ${now})
    on conflict (user_id) do update
      set expires_at = excluded.expires_at, used_at = null, note_id = excluded.note_id,
        password_hash = excluded.password_hash, created_at = excluded.created_at
  `;
  const link = `${settings.publicUrl}/acceso#${note.token}`;
  if (!mailReady(settings)) {
    return { ok: true, mailed: false, link, expiresAt, reason: "El correo no está configurado." };
  }
  if (!row.contact_email) {
    return { ok: true, mailed: false, link, expiresAt, reason: "Ese usuario no tiene correo." };
  }
  const locale: Locale = row.locale === "en" ? "en" : "es";
  try {
    await sendMail(
      sql,
      accessMail(locale, {
        to: row.contact_email,
        name: row.name,
        loginName: row.login_name ?? "",
        link,
        signInUrl: settings.publicUrl,
        expiresAt,
        resent: options.resent,
      }),
    );
    return { ok: true, mailed: true, expiresAt };
  } catch (error) {
    return {
      ok: true,
      mailed: false,
      link,
      expiresAt,
      reason: error instanceof Error ? error.message : "No se pudo enviar el correo.",
    };
  }
}

export type TempState = "none" | "ok" | "expired" | "used";

/**
 * Better Auth calls this after password verification but before session creation. Reject
 * expired/used temporary access and atomically mark the first valid use.
 */
export async function claimTempAccess(sql: Sql, userId: string): Promise<TempState> {
  const rows = await sql<{ expires_at: unknown; used_at: unknown }>`
    select expires_at, used_at from app_temp_access where user_id = ${userId} limit 1
  `;
  const row = rows[0];
  if (!row) return "none";
  if (Number(row.expires_at) <= Date.now()) return "expired";
  if (row.used_at !== null && row.used_at !== undefined) return "used";
  const claimed = await sql<{ user_id: string }>`
    update app_temp_access set used_at = ${Date.now()} where user_id = ${userId} and used_at is null returning user_id
  `;
  return claimed[0] ? "ok" : "used";
}

/** Whether the user signed in with a temporary password that remains unchanged. */
export async function pendingTempAccess(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{
    user_id: string;
  }>`select user_id from app_temp_access where user_id = ${userId} limit 1`;
  return Boolean(rows[0]);
}

/** Remove temporary access only after the account password hash differs from the temporary hash. */
export async function clearTempAccess(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ changed: unknown }>`
    select coalesce(a.password, '') <> t.password_hash as changed
    from app_temp_access t
    left join "account" a on a."userId" = t.user_id and a."providerId" = 'credential'
    where t.user_id = ${userId}
    limit 1
  `;
  if (!rows[0]) return true;
  if (rows[0].changed !== true && rows[0].changed !== "t") return false;
  const deleted = await sql<{
    note_id: string | null;
  }>`delete from app_temp_access where user_id = ${userId} returning note_id`;
  if (deleted[0]?.note_id) await dropNote(sql, deleted[0].note_id);
  return true;
}
