import { randomInt } from "node:crypto";
import type { Sql } from "@/lib/db";
import type { Locale } from "@/domain/i18n";
import { accessMail, mailReady, readMailSettings, sendMail } from "./mail";
import { createNote, dropNote } from "./secret-note";

/**
 * Acceso inicial por correo (solo servidor). Ver docs/MAIL.md.
 *
 * Al crear un usuario (o al reenviarle el acceso) se genera una contraseña
 * temporal aleatoria. Se guarda solo como hash, en la cuenta de Better Auth, y
 * en claro únicamente dentro de una nota secreta de un solo uso (ver
 * `secret-note.ts`) cuyo enlace va en el correo. La contraseña:
 *
 * - vence a las `mail_access_hours` horas (`app_temp_access.expires_at`);
 * - sirve para entrar una sola vez (`used_at`): el gancho de sesión de
 *   `lib/auth/server.ts` rechaza un segundo ingreso;
 * - obliga a elegir otra al entrar; al cambiarla se borra la fila.
 */

/** Sin caracteres que se confunden (0/O, 1/l/I). 16 de 56 posibles ≈ 93 bits. */
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
 * Pone una contraseña temporal nueva al usuario y le manda el acceso por
 * correo. Si el correo no está configurado o falla, devuelve el enlace para
 * que el administrador se lo entregue por otro medio (así Grafito sigue
 * funcionando sin correo, también sin conexión).
 */
export async function issueAccess(sql: Sql, userId: string, options: { resent: boolean }): Promise<AccessResult> {
  const settings = await readMailSettings(sql);
  const person = await sql<{ name: string; login_name: string | null; contact_email: string | null; locale: string | null }>`
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
  // El acceso anterior deja de valer: su nota, sus sesiones y su contraseña.
  const previous = await sql<{ note_id: string | null }>`select note_id from app_temp_access where user_id = ${userId}`;
  if (previous[0]?.note_id) await dropNote(sql, previous[0].note_id);
  if (options.resent) await sql`delete from "session" where "userId" = ${userId}`;
  // La nota lleva lo que la persona necesita para entrar: usuario y contraseña.
  const note = await createNote(sql, JSON.stringify({ password, login: row.login_name ?? "", expiresAt }), expiresAt);
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
    return { ok: true, mailed: false, link, expiresAt, reason: error instanceof Error ? error.message : "No se pudo enviar el correo." };
  }
}

export type TempState = "none" | "ok" | "expired" | "used";

/**
 * Lo llama Better Auth antes de crear una sesión (la contraseña ya se
 * comprobó). Un acceso temporal vencido o ya usado no entra; el primero válido
 * queda marcado como usado.
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

/** Si el usuario entró con una contraseña temporal y aún no la cambió. */
export async function pendingTempAccess(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql<{ user_id: string }>`select user_id from app_temp_access where user_id = ${userId} limit 1`;
  return Boolean(rows[0]);
}

/**
 * La persona ya eligió su contraseña: el acceso temporal deja de existir. Solo
 * si de verdad la cambió (el hash de la cuenta ya no es el temporal).
 */
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
  const deleted = await sql<{ note_id: string | null }>`delete from app_temp_access where user_id = ${userId} returning note_id`;
  if (deleted[0]?.note_id) await dropNote(sql, deleted[0].note_id);
  return true;
}
