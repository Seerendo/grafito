import {
  ensureOk,
  joinUrl,
  parseArguments,
  type ChatMessage,
  type CompleteInput,
  type Completion,
  type Endpoint,
  type ToolSpec,
} from "./types.ts";

/**
 * Protocolo Chat Completions de OpenAI. Lo usan ChatGPT, Grok (xAI), DeepSeek,
 * Kimi (Moonshot) y LM Studio: `POST {base}/chat/completions` con
 * `Authorization: Bearer`, herramientas como `tools[].function` y llamadas en
 * `message.tool_calls[].function.arguments` (texto JSON).
 */

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export function toRequest(model: string, messages: ChatMessage[], tools: ToolSpec[]) {
  const mapped: OpenAiMessage[] = messages.map((message) => {
    if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
  return {
    model,
    messages: mapped,
    ...(tools.length
      ? {
          tools: tools.map((tool) => ({
            type: "function" as const,
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
  };
}

export function fromResponse(body: unknown): Completion {
  const message = (body as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
      };
    }[];
  }).choices?.[0]?.message;
  return {
    text: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, index) => ({
        id: call.id || `call_${index}`,
        name: call.function!.name!,
        arguments: parseArguments(call.function!.arguments),
      })),
  };
}

function headers(endpoint: Endpoint): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

export async function complete(input: CompleteInput): Promise<Completion> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(joinUrl(input.endpoint.baseUrl, "chat/completions"), {
    method: "POST",
    headers: headers(input.endpoint),
    body: JSON.stringify(toRequest(input.model, input.messages, input.tools)),
    signal: input.signal,
    redirect: "error",
  });
  await ensureOk(response, "El proveedor");
  return fromResponse(await response.json());
}

export async function listModels(endpoint: Endpoint, fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher(joinUrl(endpoint.baseUrl, "models"), { headers: headers(endpoint), redirect: "error" });
  await ensureOk(response, "El proveedor");
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((model) => model.id ?? "").filter(Boolean).sort();
}
