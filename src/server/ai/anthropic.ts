import {
  ensureOk,
  joinUrl,
  type ChatMessage,
  type CompleteInput,
  type Completion,
  type Endpoint,
  type ToolSpec,
} from "./types.ts";

/**
 * Messages API de Anthropic (Claude): `POST {base}/v1/messages` con
 * `x-api-key` y `anthropic-version`. El mensaje de sistema va aparte, las
 * herramientas usan `input_schema`, las llamadas son bloques `tool_use` y los
 * resultados van en un mensaje `user` con bloques `tool_result` (los
 * resultados seguidos se agrupan en uno solo, como exige la API).
 */

const VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = { role: "user" | "assistant"; content: Block[] };

export function toRequest(model: string, messages: ChatMessage[], tools: ToolSpec[]) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") push("user", [{ type: "text", text: message.content }]);
    else if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }]);
    } else {
      const blocks: Block[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      if (blocks.length) push("assistant", blocks);
    }
  }
  return {
    model,
    max_tokens: MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: out,
    ...(tools.length
      ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
      : {}),
  };
}

export function fromResponse(body: unknown): Completion {
  const blocks = ((body as { content?: unknown[] }).content ?? []) as {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }[];
  return {
    text: blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join(""),
    toolCalls: blocks
      .filter((block) => block.type === "tool_use" && block.name)
      .map((block, index) => ({ id: block.id || `toolu_${index}`, name: block.name!, arguments: block.input ?? {} })),
  };
}

function headers(endpoint: Endpoint): Record<string, string> {
  return { "content-type": "application/json", "x-api-key": endpoint.apiKey, "anthropic-version": VERSION };
}

export async function complete(input: CompleteInput): Promise<Completion> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(joinUrl(input.endpoint.baseUrl, "v1/messages"), {
    method: "POST",
    headers: headers(input.endpoint),
    body: JSON.stringify(toRequest(input.model, input.messages, input.tools)),
    signal: input.signal,
    redirect: "error",
  });
  await ensureOk(response, "Claude");
  return fromResponse(await response.json());
}

export async function listModels(endpoint: Endpoint, fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher(joinUrl(endpoint.baseUrl, "v1/models?limit=100"), { headers: headers(endpoint), redirect: "error" });
  await ensureOk(response, "Claude");
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((model) => model.id ?? "").filter(Boolean);
}
