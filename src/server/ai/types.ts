/**
 * Common conversation representation translated by provider adapters. Relative imports allow
 * direct Node tests.
 */

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Simple JSON object schema with string, number and boolean properties. */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string" | "number" | "boolean"; description: string }>;
    required: string[];
  };
};

export type Completion = { text: string; toolCalls: ToolCall[] };

export type Endpoint = {
  baseUrl: string;
  apiKey: string;
  /** Additional provider headers must not override Authorization. */
  headers?: Record<string, string>;
};

export type CompleteInput = {
  endpoint: Endpoint;
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Inject a fetch replacement for tests. */
  fetcher?: typeof fetch;
};

export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Throw a readable error derived from the provider response. */
export async function ensureOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    detail =
      typeof body.error === "string" ? body.error : body.error?.message || body.message || "";
  } catch {
    /* No JSON response body. */
  }
  const hint =
    response.status === 401 || response.status === 403
      ? "La clave no es válida o no tiene permiso."
      : response.status === 404
        ? "Ese modelo o dirección no existe."
        : response.status === 429
          ? "El proveedor limitó las peticiones o la cuenta no tiene saldo."
          : "";
  throw new ProviderError(
    `${label} respondió ${response.status}. ${hint} ${detail}`.trim(),
    response.status,
  );
}

export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
