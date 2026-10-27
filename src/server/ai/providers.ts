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

/** Modelos de embeddings (`text-embedding-…`, `nomic-embed-text`…): no conversan. */
const EMBEDDING = /embed/i;

export async function listModels(protocol: Protocol, endpoint: Endpoint, fetcher?: typeof fetch): Promise<string[]> {
  return chatModels(await ADAPTERS[protocol].listModels(endpoint, fetcher));
}

/** Solo los modelos que sirven para el chat. */
export function chatModels(names: string[]): string[] {
  return names.filter((name) => !EMBEDDING.test(name));
}
