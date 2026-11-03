/**
 * Interpret clamd INSTREAM responses and decide whether to accept a file. Socket handling lives
 * in server/clamav.ts.
 */

export type ScanVerdict = "clean" | "infected" | "error";

const NUL = String.fromCharCode(0);

/** stream: OK means clean; stream: <signature> FOUND means infected; anything else is a failure. */
export function parseClamdReply(raw: string): {
  verdict: ScanVerdict;
  signature: string;
  detail: string;
} {
  const line = raw.split(NUL).join("").trim();
  const found = /:\s*(.+)\s+FOUND$/i.exec(line);
  if (found) return { verdict: "infected", signature: (found[1] ?? "").trim(), detail: line };
  if (/:\s*OK$/i.test(line)) return { verdict: "clean", signature: "", detail: line };
  return { verdict: "error", signature: "", detail: line || "Sin respuesta del antivirus." };
}

/**
 * Allow files when scanning is disabled or returns clean. Reject infected files and scanner
 * failures without retaining the object.
 */
export function scanDecision(
  configured: boolean,
  verdict: ScanVerdict | "off",
): "allow" | "reject" {
  if (!configured || verdict === "off" || verdict === "clean") return "allow";
  return "reject";
}

/** Settings persisted by security administration. */
export type ClamavConfig = {
  enabled: boolean;
  host: string;
  port: number;
  timeoutSeconds: number;
};

/** Compose scanner address used until settings are saved. */
export const DEFAULT_CLAMAV: ClamavConfig = {
  enabled: true,
  host: "clamav",
  port: 3310,
  timeoutSeconds: 60,
};

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Hostname or IPv4 address; empty is valid only when scanning is disabled. */
export function parseClamavConfig(
  input: ClamavConfig,
): { ok: true; config: ClamavConfig } | { ok: false; error: string } {
  const host = input.host.trim();
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { ok: false, error: "El puerto tiene que estar entre 1 y 65535." };
  }
  if (
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 5 ||
    input.timeoutSeconds > 120
  ) {
    return { ok: false, error: "El tiempo de espera tiene que estar entre 5 y 120 segundos." };
  }
  if (host && !HOSTNAME.test(host) && !IPV4.test(host)) {
    return { ok: false, error: "El servidor no es un nombre o una dirección válidos." };
  }
  if (input.enabled && !host) return { ok: false, error: "Escribe el servidor del antivirus." };
  return {
    ok: true,
    config: {
      enabled: input.enabled,
      host,
      port: input.port,
      timeoutSeconds: input.timeoutSeconds,
    },
  };
}

/** null means scanning is unnecessary. */
export function clamavEndpoint(config: ClamavConfig): { host: string; port: number } | null {
  if (!config.enabled || !config.host) return null;
  return { host: config.host, port: config.port };
}
