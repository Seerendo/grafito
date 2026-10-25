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
 * Generative Language API de Google (Gemini):
 * `POST {base}/models/{modelo}:generateContent` con `x-goog-api-key`. Los
 * turnos son `contents` con rol `user` o `model`; el sistema va en
 * `systemInstruction`; las herramientas son `functionDeclarations`; las
 * llamadas llegan como partes `functionCall` y los resultados vuelven como
 * partes `functionResponse` en un turno `user`.
 */

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: unknown } } };

type Content = { role: "user" | "model"; parts: Part[] };

function modelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function parseContent(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function toRequest(messages: ChatMessage[], tools: ToolSpec[]) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents: Content[] = [];
  const push = (role: Content["role"], parts: Part[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") push("user", [{ text: message.content }]);
    else if (message.role === "tool") {
      push("user", [{ functionResponse: { name: message.name, response: { content: parseContent(message.content) } } }]);
    } else {
      const parts: Part[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.arguments } });
      if (parts.length) push("model", parts);
    }
  }
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          ],
        }
      : {}),
  };
}

export function fromResponse(body: unknown): Completion {
  const parts = ((body as { candidates?: { content?: { parts?: unknown[] } }[] }).candidates?.[0]?.content?.parts ??
    []) as { text?: string; functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }[];
  return {
    text: parts.map((part) => part.text ?? "").join(""),
    toolCalls: parts
      .filter((part) => part.functionCall?.name)
      .map((part, index) => ({
        id: part.functionCall!.id || `fc_${index}_${part.functionCall!.name}`,
        name: part.functionCall!.name!,
        arguments: part.functionCall!.args ?? {},
      })),
  };
}

function headers(endpoint: Endpoint): Record<string, string> {
  return { "content-type": "application/json", "x-goog-api-key": endpoint.apiKey };
}

export async function complete(input: CompleteInput): Promise<Completion> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(joinUrl(input.endpoint.baseUrl, `${modelPath(input.model)}:generateContent`), {
    method: "POST",
    headers: headers(input.endpoint),
    body: JSON.stringify(toRequest(input.messages, input.tools)),
    signal: input.signal,
    redirect: "error",
  });
  await ensureOk(response, "Gemini");
  return fromResponse(await response.json());
}

export async function listModels(endpoint: Endpoint, fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher(joinUrl(endpoint.baseUrl, "models?pageSize=200"), { headers: headers(endpoint), redirect: "error" });
  await ensureOk(response, "Gemini");
  const body = (await response.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  return (body.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => (model.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}
