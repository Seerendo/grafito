import type { Sql } from "@/lib/db";
import { intlLocale, translate, type Locale } from "@/domain/i18n";
import { decrypt, encrypt } from "./crypto";

/**
 * Correo electrónico por SMTP (solo servidor). Ver docs/MAIL.md.
 *
 * La configuración vive en `app_setting` (claves `mail_*`) y se edita en
 * Administración → Correo electrónico; la contraseña del servidor SMTP se
 * guarda cifrada con `GRAFITO_ENCRYPTION_KEY`. Sin servidor ni remitente, el
 * correo está apagado y Grafito funciona igual (sin avisos, y el acceso de los
 * usuarios nuevos se entrega a mano con el enlace).
 */

export type MailSecurity = "none" | "starttls" | "tls";

export type MailSettings = {
  host: string;
  port: number;
  security: MailSecurity;
  user: string;
  hasPassword: boolean;
  from: string;
  fromName: string;
  /** Dirección con la que se abre Grafito, para los enlaces de los correos. */
  publicUrl: string;
  /** Horas que vale el acceso temporal de un usuario nuevo. */
  accessHours: number;
};

export type MailInput = Omit<MailSettings, "hasPassword"> & { password?: string; clearPassword?: boolean };

export type Mail = { to: string; subject: string; text: string; html: string };

const KEYS = {
  host: "mail_host",
  port: "mail_port",
  security: "mail_security",
  user: "mail_user",
  password: "mail_password",
  from: "mail_from",
  fromName: "mail_from_name",
  publicUrl: "mail_public_url",
  accessHours: "mail_access_hours",
} as const;

export const DEFAULT_ACCESS_HOURS = 24;
const CACHE_MS = 15_000;

let cache: { at: number; value: MailSettings & { password: string } } | null = null;

function defaultPublicUrl(): string {
  return (process.env.BETTER_AUTH_URL?.trim() || "http://127.0.0.1:8080").replace(/\/+$/, "");
}

export async function readMailSettings(sql: Sql): Promise<MailSettings & { password: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const rows = await sql<{ key: string; value: string }>`select key, value from app_setting where key like 'mail_%'`;
  const raw = new Map(rows.map((row) => [row.key, row.value]));
  let password = "";
  const sealed = raw.get(KEYS.password);
  if (sealed) {
    try {
      password = decrypt(sealed);
    } catch {
      password = "";
    }
  }
  const security = raw.get(KEYS.security);
  const hours = Number(raw.get(KEYS.accessHours));
  const value = {
    host: raw.get(KEYS.host) ?? "",
    port: Number(raw.get(KEYS.port)) || 587,
    security: security === "none" || security === "tls" ? security : "starttls",
    user: raw.get(KEYS.user) ?? "",
    hasPassword: Boolean(sealed),
    password,
    from: raw.get(KEYS.from) ?? "",
    fromName: raw.get(KEYS.fromName) ?? "Grafito",
    publicUrl: (raw.get(KEYS.publicUrl) || defaultPublicUrl()).replace(/\/+$/, ""),
    accessHours: Number.isFinite(hours) && hours >= 1 ? Math.min(hours, 720) : DEFAULT_ACCESS_HOURS,
  } satisfies MailSettings & { password: string };
  cache = { at: Date.now(), value };
  return value;
}

export function mailReady(settings: Pick<MailSettings, "host" | "from">): boolean {
  return Boolean(settings.host && settings.from);
}

export async function writeMailSettings(sql: Sql, input: MailInput): Promise<void> {
  const values: [string, string][] = [
    [KEYS.host, input.host.trim()],
    [KEYS.port, String(input.port)],
    [KEYS.security, input.security],
    [KEYS.user, input.user.trim()],
    [KEYS.from, input.from.trim()],
    [KEYS.fromName, input.fromName.trim()],
    [KEYS.publicUrl, input.publicUrl.trim().replace(/\/+$/, "")],
    [KEYS.accessHours, String(input.accessHours)],
  ];
  // Una contraseña vacía conserva la anterior; `clearPassword` la quita.
  if (input.password) values.push([KEYS.password, encrypt(input.password)]);
  for (const [key, value] of values) {
    await sql`
      insert into app_setting (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value
    `;
  }
  if (input.clearPassword && !input.password) await sql`delete from app_setting where key = ${KEYS.password}`;
  cache = null;
}

/** Envía un correo con la configuración guardada. Lanza un error legible si falla. */
export async function sendMail(sql: Sql, mail: Mail, override?: MailSettings & { password: string }): Promise<void> {
  const settings = override ?? (await readMailSettings(sql));
  if (!mailReady(settings)) throw new Error("El correo no está configurado.");
  const { createTransport } = await import("nodemailer");
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: settings.fromName ? { name: settings.fromName, address: settings.from } : settings.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (error) {
    throw new Error(mailProblem(error));
  } finally {
    transport.close();
  }
}

function mailProblem(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
  if (/EAUTH|Invalid login|authentication/i.test(text)) return "El servidor de correo rechazó el usuario o la contraseña.";
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|ECONNECTION|timeout/i.test(text)) {
    return "No se pudo conectar con el servidor de correo. Revisa el servidor, el puerto y la seguridad.";
  }
  if (/certificate|SSL|TLS|wrong version/i.test(text)) return "Falló la conexión segura (TLS). Revisa el puerto y la seguridad.";
  if (/recipient|mailbox|550|553/i.test(text)) return "El servidor de correo rechazó el destinatario.";
  console.error("[mail]", error);
  return "No se pudo enviar el correo.";
}

// --- Plantillas -----------------------------------------------------------------

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f2ee;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1b18">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8a8378">Grafito</p>
<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">${escape(title)}</h1>
${body}
</div></body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:20px 0"><a href="${escape(href)}" style="display:inline-block;background:#c8873a;color:#1d1b18;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">${escape(label)}</a></p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;line-height:1.5">${escape(text)}</p>`;
}

function when(locale: Locale, ms: number): string {
  // Con la zona horaria: el servidor puede estar en otra (en Docker, UTC salvo `TZ`).
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}

export function testMail(locale: Locale, to: string): Mail {
  const tr = (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars);
  const title = tr("Correo de prueba");
  const line = tr("Si lees esto, Grafito ya puede enviar correos.");
  return { to, subject: tr("Grafito: correo de prueba"), text: `${title}\n\n${line}\n`, html: layout(title, paragraph(line)) };
}

export function accessMail(
  locale: Locale,
  input: { to: string; name: string; loginName: string; link: string; signInUrl: string; expiresAt: number; resent: boolean },
): Mail {
  const tr = (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars);
  const expires = when(locale, input.expiresAt);
  const title = input.resent ? tr("Tu nuevo acceso a Grafito") : tr("Tu acceso a Grafito");
  const lines = [
    tr("Hola, {0}.", { 0: input.name }),
    input.resent
      ? tr("Un administrador te envió un acceso nuevo. El anterior ya no sirve.")
      : tr("Un administrador te creó una cuenta en Grafito."),
    tr("Tu usuario es: {0}", { 0: input.loginName }),
    tr("Tu contraseña temporal está en una nota privada que solo se puede abrir una vez: al cerrarla o recargarla, desaparece."),
  ];
  const after = [
    tr("El enlace y la contraseña vencen el {0}.", { 0: expires }),
    tr("La contraseña sirve para entrar una sola vez; al entrar tendrás que elegir una nueva."),
    tr("Si el enlace no funciona o ya venció, pide al administrador que te envíe un acceso nuevo."),
  ];
  const text = [
    title,
    "",
    ...lines,
    "",
    `${tr("Ver mi contraseña")}: ${input.link}`,
    `${tr("Entrar en Grafito")}: ${input.signInUrl}`,
    "",
    ...after,
  ].join("\n");
  const html = layout(
    title,
    lines.map(paragraph).join("") +
      button(input.link, tr("Ver mi contraseña")) +
      after.map(paragraph).join("") +
      `<p style="margin:16px 0 0;font-size:13px;color:#8a8378">${escape(tr("Entrar en Grafito"))}: <a href="${escape(input.signInUrl)}">${escape(input.signInUrl)}</a></p>`,
  );
  return { to: input.to, subject: title, text, html };
}

export function changesMail(
  locale: Locale,
  input: { to: string; name: string; url: string; items: { title: string; actors: string[] }[] },
): Mail {
  const tr = (text: string, vars?: Record<string, string | number>) => translate(locale, text, vars);
  const single = input.items.length === 1 ? input.items[0]! : null;
  const subject = single
    ? tr("Cambios en «{0}»", { 0: single.title })
    : tr("Cambios en {0} documentos", { 0: input.items.length });
  const intro = tr("Hola, {0}. Hubo cambios en documentos a los que tienes acceso:", { 0: input.name });
  const rows = input.items.map((item) => tr("«{0}», por {1}", { 0: item.title, 1: item.actors.join(", ") }));
  const footer = tr("Puedes dejar de recibir estos avisos en Cuenta → Correo.");
  const text = [subject, "", intro, "", ...rows.map((row) => `- ${row}`), "", `${tr("Abrir Grafito")}: ${input.url}`, "", footer].join("\n");
  const html = layout(
    subject,
    paragraph(intro) +
      `<ul style="margin:0 0 12px;padding-left:20px;line-height:1.6">${rows.map((row) => `<li>${escape(row)}</li>`).join("")}</ul>` +
      button(input.url, tr("Abrir Grafito")) +
      `<p style="margin:16px 0 0;font-size:13px;color:#8a8378">${escape(footer)}</p>`,
  );
  return { to: input.to, subject, text, html };
}
