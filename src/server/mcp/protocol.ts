import type { ToolCall, ToolSpec } from "./types.ts";

/**
 * MCP over Streamable HTTP, answered as plain JSON (no server-sent events): initialize, ping,
 * tools/list and tools/call. Notifications get no answer. Relative imports allow direct Node tests.
 */

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type McpTool = { spec: ToolSpec; writes: boolean; destructive: boolean };

export type McpServer = {
  version: string;
  tools: McpTool[];
  call: (call: ToolCall) => Promise<{ text: string; isError: boolean }>;
};

type JsonRpcId = string | number | null;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

export const INSTRUCTIONS =
  "Grafito: notas, archivos, tablas y portafolios de la persona dueña del token, y lo que otras personas le compartieron. " +
  "Los documentos se nombran por id o por título; si hay varios con el mismo título, la herramienta devuelve los ids. " +
  "Antes de eliminar algo, pregunta a la persona y espera su confirmación; las herramientas de eliminar piden repetir el nombre en confirm.";

function reply(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function error(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function validId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function describe(tool: McpTool) {
  return {
    name: tool.spec.name,
    description: tool.spec.description,
    inputSchema: tool.spec.parameters,
    annotations: {
      readOnlyHint: !tool.writes,
      destructiveHint: tool.destructive,
      openWorldHint: false,
    },
  };
}

/** Answer one JSON-RPC message; null for a notification or a response sent to us. */
async function answer(server: McpServer, message: Message): Promise<object | null> {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0")
    return error(null, -32600, "Invalid Request");
  const hasId = "id" in message && message.id !== undefined;
  if (typeof message.method !== "string") {
    // A response or a malformed request: responses from the client need no answer.
    return hasId && !("result" in message || "error" in message)
      ? error(validId(message.id) ? message.id : null, -32600, "Invalid Request")
      : null;
  }
  if (!hasId) return null;
  if (!validId(message.id)) return error(null, -32600, "Invalid Request");
  const id = message.id;
  const params =
    message.params && typeof message.params === "object"
      ? (message.params as Record<string, unknown>)
      : {};
  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "grafito", title: "Grafito", version: server.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: server.tools.map(describe) });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (!server.tools.some((tool) => tool.spec.name === name))
        return error(id, -32602, `Unknown tool: ${name}`);
      const outcome = await server.call({ name, arguments: args });
      return reply(id, {
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
      });
    }
    default:
      return error(id, -32601, `Method not found: ${message.method}`);
  }
}

/**
 * The HTTP answer to a POSTed body: a JSON-RPC response (or a batch of them), or null when only
 * notifications came (HTTP 202 with no body).
 */
export async function handleMcp(
  server: McpServer,
  body: unknown,
): Promise<object | object[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return error(null, -32600, "Invalid Request");
    const answers: object[] = [];
    for (const item of body.slice(0, 50)) {
      const one = await answer(server, item as Message);
      if (one) answers.push(one);
    }
    return answers.length ? answers : null;
  }
  return answer(server, body as Message);
}
