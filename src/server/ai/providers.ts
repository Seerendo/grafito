import * as anthropic from "./anthropic.ts";
import * as gemini from "./gemini.ts";
import * as ollama from "./ollama.ts";
import * as openai from "./openai.ts";
import type { CompleteInput, Completion, Endpoint } from "./types.ts";

/** Elige el adaptador según el protocolo del proveedor (ver `domain/ai.ts`). */

export type Protocol = "openai" | "anthropic" | "gemini" | "ollama";

const ADAPTERS = { openai, anthropic, gemini, ollama } satisfies Record<
  Protocol,
  {
    complete: (input: CompleteInput) => Promise<Completion>;
    listModels: (endpoint: Endpoint, fetcher?: typeof fetch) => Promise<string[]>;
  }
>;

export function complete(protocol: Protocol, input: CompleteInput): Promise<Completion> {
  return ADAPTERS[protocol].complete(input);
}

export function listModels(protocol: Protocol, endpoint: Endpoint, fetcher?: typeof fetch): Promise<string[]> {
  return ADAPTERS[protocol].listModels(endpoint, fetcher);
}
