import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { encryptionReady } from "@/server/crypto";
import { mailReady, readMailSettings, sendMail, testMail, writeMailSettings } from "@/server/mail";

/**
 * Administración → Correo electrónico (permiso `mail.manage`), Cuenta → Correo
 * y la nota secreta del correo de acceso. Ver docs/MAIL.md.
 */

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function manager(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, profile, allowed: allows(profile, "mail.manage") };
}

const settingsInput = z.object({
  host: z.string().trim().max(200),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["none", "starttls", "tls"]),
  user: z.string().trim().max(200),
  password: z.string().max(400).optional(),
  clearPassword: z.boolean().optional(),
  from: z.string().trim().max(200),
  fromName: z.string().trim().max(120),
  publicUrl: z.string().trim().max(300),
  accessHours: z.number().int().min(1).max(720),
});

function checkSettings(data: z.infer<typeof settingsInput>): string {
  if (data.from && !emailPattern.test(data.from)) return "El remitente no es un correo válido.";
  if (data.host && !data.from) return "Falta el correo del remitente.";
  if (data.publicUrl) {
    try {
      const url = new URL(data.publicUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "La dirección de Grafito debe empezar por http:// o https://.";
    } catch {
      return "La dirección de Grafito no es válida (ej.: https://notas.ejemplo.com).";
    }
  }
  return "";
}

export const mailState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const };
    const { password: _password, ...settings } = await readMailSettings(sql);
    return { ok: true as const, settings, ready: mailReady(settings), encryption: encryptionReady() };
  });

export const saveMailSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => settingsInput.parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const, error: "Sin permiso." };
    const problem = checkSettings(data);
    if (problem) return { ok: false as const, error: problem };
    if (data.password && !encryptionReady()) {
      return { ok: false as const, error: "Falta GRAFITO_ENCRYPTION_KEY en el servidor: no se puede guardar la contraseña." };
    }
    await writeMailSettings(sql, data);
    await sql`
      insert into app_log (id, actor, area, message)
      values (${crypto.randomUUID()}, ${profile.loginName || profile.displayName}, 'Correo', 'Actualiza la configuración de correo')
    `;
    return { ok: true as const };
  });

/** Prueba con lo que hay en el formulario (sin guardarlo); sin contraseña, usa la guardada. */
export const sendTestMail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => settingsInput.extend({ to: z.string().trim().max(200) }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile, allowed } = await manager(context.userId);
    if (!allowed) return { ok: false as const, error: "Sin permiso." };
    if (!emailPattern.test(data.to)) return { ok: false as const, error: "Escribe un correo válido para la prueba." };
    const problem = checkSettings(data);
    if (problem) return { ok: false as const, error: problem };
    const saved = await readMailSettings(sql);
    const settings = {
      ...data,
      password: data.clearPassword ? "" : data.password || saved.password,
      hasPassword: true,
      publicUrl: data.publicUrl || saved.publicUrl,
    };
    if (!mailReady(settings)) return { ok: false as const, error: "Falta el servidor o el remitente." };
    try {
      await sendMail(sql, testMail(profile.locale || "es", data.to), settings);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "No se pudo enviar el correo." };
    }
  });

// --- Cuenta → Correo --------------------------------------------------------------

export const mailPreferences = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    const settings = await readMailSettings(sql);
    return { email: profile.contactEmail, notifyChanges: profile.notifyChanges, mailOn: mailReady(settings) };
  });

export const saveMailPreferences = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ email: z.string().trim().max(120), notifyChanges: z.boolean() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    if (data.email && !emailPattern.test(data.email)) return { ok: false as const, error: "El correo no es válido." };
    const sql = await requireLease(context.userId);
    const email = data.email || null;
    await sql`
      insert into app_profile (user_id, contact_email, notify_changes)
      values (${context.userId}, ${email}, ${data.notifyChanges})
      on conflict (user_id) do update set contact_email = excluded.contact_email, notify_changes = excluded.notify_changes
    `;
    return { ok: true as const, email: data.email, notifyChanges: data.notifyChanges };
  });

// --- Nota secreta del correo de acceso (sin sesión) -------------------------------

/**
 * Abre la nota del correo de acceso y la destruye. Sin sesión: quien tiene el
 * enlace es quien la puede leer, una sola vez.
 */
export const revealAccessNote = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ token: z.string().max(100) }).parse(input))
  .handler(async ({ data }) => {
    const { getSql } = await import("@/lib/db");
    const { takeNote } = await import("@/server/secret-note");
    const sql = await getSql();
    const plain = await takeNote(sql, data.token);
    if (!plain) return { ok: false as const };
    try {
      const note = JSON.parse(plain) as { password?: string; login?: string; expiresAt?: number };
      if (!note.password) return { ok: false as const };
      return { ok: true as const, password: note.password, login: note.login ?? "", expiresAt: note.expiresAt ?? 0 };
    } catch {
      return { ok: false as const };
    }
  });
