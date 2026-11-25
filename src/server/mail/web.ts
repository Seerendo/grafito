import { request } from "node:https";
import { MailError } from "./providers/types";
import { resolveWebTarget } from "./settings";

/**
 * HTTPS to a mail server's web side (Zimbra's directory, CalDAV) with the same rules as IMAP: the
 * name is resolved once and checked (no loopback, metadata or internal services; a private
 * network only for MAIL_TRUSTED_HOSTS), the connection goes to that checked address with the name
 * kept for TLS, the certificate is always validated, and every redirect is checked again.
 */

export type WebAnswer = { status: number; headers: Record<string, string>; body: string };

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export async function webRequest(
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    auth?: { user: string; pass: string };
    timeoutMs?: number;
  },
): Promise<WebAnswer> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const answer = await once(current, init);
    const location = answer.headers.location;
    if (answer.status >= 300 && answer.status < 400 && location) {
      const next = new URL(location, current);
      if (next.protocol !== "https:")
        throw new MailError("permanent", "El servidor redirigió a una dirección sin cifrar.");
      // Credentials only follow a redirect to the same host.
      const sameHost = next.host === new URL(current).host;
      current = next.toString();
      if (!sameHost) init = { ...init, auth: undefined };
      continue;
    }
    return answer;
  }
  throw new MailError("permanent", "El servidor redirigió demasiadas veces.");
}

async function once(
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    auth?: { user: string; pass: string };
    timeoutMs?: number;
  },
): Promise<WebAnswer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MailError("permanent", "La dirección del servidor no es válida.");
  }
  if (parsed.protocol !== "https:")
    throw new MailError("permanent", "La dirección tiene que empezar por https://.");
  if (parsed.username || parsed.password)
    throw new MailError("permanent", "La dirección no puede llevar usuario ni contraseña.");
  const host = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || 443);
  const target = await resolveWebTarget(host, port);
  if (!target.ok) throw new MailError("permanent", target.error);
  const headers: Record<string, string> = { "user-agent": "Grafito", ...init.headers };
  if (init.auth)
    headers.authorization = `Basic ${Buffer.from(`${init.auth.user}:${init.auth.pass}`).toString("base64")}`;
  if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
  return new Promise<WebAnswer>((resolve, reject) => {
    const req = request(
      {
        host: target.address,
        servername: host,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        headers: { ...headers, host: parsed.port ? `${host}:${parsed.port}` : host },
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        timeout: init.timeoutMs ?? 20_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new MailError("permanent", "El servidor respondió demasiado."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(", ") : value;
          resolve({
            status: response.statusCode ?? 0,
            headers: flat,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => reject(classify(error)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => reject(classify(error)));
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function classify(error: unknown): MailError {
  if (error instanceof MailError) return error;
  const text = `${(error as { code?: string })?.code ?? ""} ${(error as Error)?.message ?? ""}`;
  if (/CERT|self.signed|unable to verify|altnames|UNABLE_TO_GET_ISSUER/i.test(text))
    return new MailError(
      "connection",
      "El certificado del servidor no es válido para ese nombre. Grafito no se conecta sin verificarlo.",
    );
  if (/ECONNREFUSED/.test(text))
    return new MailError("connection", "El servidor rechazó la conexión.");
  if (/ETIMEDOUT|timeout/i.test(text))
    return new MailError("connection", "El servidor no respondió a tiempo.");
  return new MailError("connection", "No se pudo contactar con el servidor.");
}
