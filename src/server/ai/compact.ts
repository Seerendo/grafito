import { fallbackMemory, summaryRequest, clipSummary } from "@/domain/ai-context";
import { complete, type Protocol } from "./providers.ts";
import type { Endpoint } from "./types.ts";

/**
 * Summarize memory with the chat model and no tools. On failure, persist a local clipped
 * fallback to avoid repeating failed summaries on every message.
 */

const SUMMARY_SYSTEM =
  "Eres el compresor de contexto de Grafito. No uses herramientas ni contestes a la persona. Escribe solo el resumen.";

export async function compressConversation(input: {
  protocol: Protocol;
  endpoint: Endpoint;
  model: string;
  prior: string;
  digest: string;
  signal?: AbortSignal;
}): Promise<string> {
  const fallback = fallbackMemory(input.prior, input.digest);
  try {
    const completion = await complete(input.protocol, {
      endpoint: input.endpoint,
      model: input.model,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: summaryRequest(input.prior, input.digest) },
      ],
      tools: [],
      signal: input.signal,
    });
    return clipSummary(completion.text) || fallback;
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
      throw error;
    console.error("[ai] memoria", error);
    return fallback;
  }
}
