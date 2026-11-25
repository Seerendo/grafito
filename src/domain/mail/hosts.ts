/**
 * Where an IMAP connection may go (SSRF). The name is resolved once, every address is checked,
 * and the connection is made to one checked address with the name kept for TLS, so a DNS answer
 * that changes between the check and the connection (rebinding) cannot redirect it. Relative
 * imports allow direct Node tests.
 */

export type HostClass =
  | "public"
  | "private"
  | "loopback"
  | "link-local"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved";

function v4(parts: number[]): HostClass {
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254)
    return parts[2] === 169 && parts[3] === 254 ? "metadata" : "link-local";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function parseV4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return numbers.every((n) => n >= 0 && n <= 255) ? numbers : null;
}

/** What kind of address an IP literal is. */
export function classifyIp(ip: string): HostClass {
  const text = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const four = parseV4(text);
  if (four) return v4(four);
  // IPv4-mapped IPv6, dotted (::ffff:1.2.3.4) or in hex (::ffff:102:304).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped?.[1]) return classifyIp(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return v4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  if (text === "::" || text === "0:0:0:0:0:0:0:0") return "unspecified";
  if (text === "::1") return "loopback";
  if (text === "fd00:ec2::254") return "metadata";
  if (/^fe[89ab][0-9a-f]:/.test(text)) return "link-local";
  if (/^f[cd][0-9a-f]{2}:/.test(text)) return "private";
  if (/^ff[0-9a-f]{2}:/.test(text)) return "multicast";
  return text.includes(":") ? "public" : "reserved";
}

/** Grafito's own Compose services: never a mail server. */
const INTERNAL = new Set([
  "postgres",
  "redis",
  "elasticsearch",
  "minio",
  "app",
  "gateway",
  "grafeno",
  "collabora",
  "clamav",
  "latex",
  "backup",
  "backup-files",
  "mail-sync",
  "localhost",
]);

/** A host matches an allow-list entry: exact, or *.suffix. */
export function hostListed(host: string, list: readonly string[]): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  return list.some((entry) => {
    const item = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!item) return false;
    if (item.startsWith("*.")) return name.endsWith(item.slice(1)) && name !== item.slice(2);
    return name === item;
  });
}

export const IMAP_PORTS = [993, 143];

export type TargetCheck = { ok: true; address: string } | { ok: false; error: string };

/**
 * Pick the address to connect to. `addresses` is what the name resolved to (or the literal).
 * A private address needs the host to be trusted (MAIL_TRUSTED_HOSTS on the server);
 * loopback, link-local, metadata and the like are never allowed.
 */
export function checkTarget(input: {
  host: string;
  port: number;
  addresses: readonly string[];
  trusted: boolean;
}): TargetCheck {
  const host = input.host.trim().toLowerCase();
  if (!host || !/^[a-z0-9.:[\]-]+$/.test(host))
    return { ok: false, error: "El servidor no es un nombre válido." };
  if (!IMAP_PORTS.includes(input.port))
    return { ok: false, error: "El puerto IMAP tiene que ser 993 (TLS) o 143 (STARTTLS)." };
  if (INTERNAL.has(host) || host.endsWith(".localhost"))
    return { ok: false, error: "Ese servidor es un servicio interno." };
  if (input.addresses.length === 0) return { ok: false, error: "No se encontró ese servidor." };
  for (const address of input.addresses) {
    const kind = classifyIp(address);
    if (kind === "public") continue;
    if (kind === "private" && input.trusted) continue;
    if (kind === "private")
      return {
        ok: false,
        error: "Ese servidor está en una red privada que este Grafito no tiene autorizada.",
      };
    return { ok: false, error: "Esa dirección no se puede usar como servidor de correo." };
  }
  return { ok: true, address: input.addresses[0]! };
}
