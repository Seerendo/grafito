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
 * API nativa de Ollama: `POST {base}/api/chat` con `stream: false`. Las
 * herramientas usan el mismo formato que OpenAI, pero los argumentos de las
 * llamadas llegan como objeto (no como texto) y los resultados se devuelven
 * con `role: "tool"` y `tool_name`. Modelos en `GET {base}/api/tags`.
 */

type OllamaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] }
  | { role: "tool"; content: string; tool_name: string };

/**
 * Contexto que se le pide a Ollama (`num_ctx`). Por defecto usa 2048–4096
 * tokens y, si la conversación no cabe, recorta por el principio: se perdían
 * las instrucciones y las herramientas, y el modelo decía haber hecho cosas
 * que no hizo. Se pide lo que hace falta (unos 3 caracteres por token, más
 * margen para la respuesta), en potencias de 2 para que Ollama no recargue el
 * modelo a cada mensaje, entre 8192 y 32768.
 */
export function contextSize(messages: ChatMessage[], tools: ToolSpec[]): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0) + JSON.stringify(tools).length;
  const needed = Math.ceil(chars / 3) + 2048;
  let size = 8192;
  while (size < needed && size < 32_768) size *= 2;
  return size;
}

export function toRequest(model: string, messages: ChatMessage[], tools: ToolSpec[]) {
  const mapped: OllamaMessage[] = messages.map((message) => {
    if (message.role === "tool") return { role: "tool", content: message.content, tool_name: message.name };
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
  return {
    model,
    stream: false,
    options: { num_ctx: contextSize(messages, tools) },
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
    message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  }).message;
  return {
    text: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, index) => ({
        id: `ollama_${index}_${call.function!.name}`,
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
  const response = await fetcher(joinUrl(input.endpoint.baseUrl, "api/chat"), {
    method: "POST",
    headers: headers(input.endpoint),
    body: JSON.stringify(toRequest(input.model, input.messages, input.tools)),
    signal: input.signal,
    redirect: "error",
  });
  await ensureOk(response, "Ollama");
  return fromResponse(await response.json());
}

export async function listModels(endpoint: Endpoint, fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher(joinUrl(endpoint.baseUrl, "api/tags"), { headers: headers(endpoint), redirect: "error" });
  await ensureOk(response, "Ollama");
  const body = (await response.json()) as { models?: { name?: string }[] };
  return (body.models ?? []).map((model) => model.name ?? "").filter(Boolean).sort();
}
