import { Client, type Entry } from "ldapts";
import type { LdapConfig } from "./providers.server";

/**
 * Verificación contra un directorio LDAP / Active Directory (solo servidor):
 * con la cuenta de servicio busca a la persona por el filtro configurado y
 * luego intenta entrar con su propio DN y la contraseña que escribió.
 */

export type LdapPerson = { dn: string; uid: string; name: string; email: string | null };

/** Escapa un valor para un filtro LDAP (RFC 4515). */
export function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function client(config: LdapConfig): Client {
  return new Client({
    url: config.url,
    timeout: 5000,
    connectTimeout: 5000,
    tlsOptions: config.allowInsecureTls ? { rejectUnauthorized: false } : undefined,
  });
}

async function open(config: LdapConfig): Promise<Client> {
  const connection = client(config);
  if (config.startTls) await connection.startTLS(config.allowInsecureTls ? { rejectUnauthorized: false } : {});
  return connection;
}

function first(entry: Entry, attribute: string): string {
  const value = entry[attribute];
  const item = Array.isArray(value) ? value[0] : value;
  if (item === undefined || item === null) return "";
  return Buffer.isBuffer(item) ? item.toString("utf8") : String(item);
}

/** Busca a una persona por su nombre de usuario con la cuenta de servicio. */
export async function findPerson(config: LdapConfig, username: string): Promise<LdapPerson | null> {
  const connection = await open(config);
  try {
    if (config.bindDn) await connection.bind(config.bindDn, config.bindPassword);
    const filter = config.userFilter.split("{{username}}").join(escapeFilter(username));
    const { searchEntries } = await connection.search(config.baseDn, {
      scope: "sub",
      filter,
      sizeLimit: 2,
      attributes: ["dn", config.nameAttr, config.emailAttr, "uid", "sAMAccountName"],
    });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0]!;
    const uid = first(entry, "uid") || first(entry, "sAMAccountName") || username;
    return {
      dn: entry.dn,
      uid,
      name: first(entry, config.nameAttr) || uid,
      email: first(entry, config.emailAttr).toLowerCase() || null,
    };
  } finally {
    await connection.unbind().catch(() => undefined);
  }
}

/** Comprueba usuario y contraseña. Devuelve la persona o `null` si no entra. */
export async function authenticate(config: LdapConfig, username: string, password: string): Promise<LdapPerson | null> {
  if (!username.trim() || !password) return null;
  const person = await findPerson(config, username.trim());
  if (!person) return null;
  const connection = await open(config);
  try {
    await connection.bind(person.dn, password);
    return person;
  } catch {
    return null;
  } finally {
    await connection.unbind().catch(() => undefined);
  }
}

/** Prueba de conexión para el panel: enlaza con la cuenta de servicio y, si se pide, busca a alguien. */
export async function testConnection(config: LdapConfig, probeUser: string): Promise<string> {
  const connection = await open(config);
  try {
    if (config.bindDn) await connection.bind(config.bindDn, config.bindPassword);
  } finally {
    await connection.unbind().catch(() => undefined);
  }
  if (!probeUser.trim()) return "Conexión correcta con la cuenta de servicio.";
  const person = await findPerson(config, probeUser.trim());
  if (!person) return `Conexión correcta, pero «${probeUser.trim()}» no aparece con ese filtro (o aparece más de una vez).`;
  return `Conexión correcta. Encontrado: ${person.name} (${person.email ?? "sin correo"}) · ${person.dn}`;
}
