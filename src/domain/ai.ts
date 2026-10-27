/**
 * Catálogo de proveedores de IA. Cada uno habla uno de cuatro protocolos:
 *
 *  - `openai`: Chat Completions (`POST /chat/completions`, `GET /models`,
 *    `Authorization: Bearer`). ChatGPT, Grok (xAI), DeepSeek, Kimi (Moonshot)
 *    y LM Studio lo implementan.
 *  - `anthropic`: Messages API de Claude (`POST /v1/messages`, `x-api-key`,
 *    `anthropic-version`, bloques `tool_use` / `tool_result`).
 *  - `gemini`: Generative Language API (`:generateContent`, `x-goog-api-key`,
 *    `functionDeclarations`, partes `functionCall` / `functionResponse`).
 *  - `ollama`: API nativa de Ollama (`POST /api/chat`, `GET /api/tags`).
 *
 * Los proveedores locales (Ollama, LM Studio) no piden clave y su dirección la
 * fija el administrador; los de la nube usan siempre su URL oficial.
 */

export type AiProviderId = "openai" | "anthropic" | "xai" | "gemini" | "deepseek" | "kimi" | "ollama" | "lmstudio";
export type AiProtocol = "openai" | "anthropic" | "gemini" | "ollama";

export type AiProviderInfo = {
  id: AiProviderId;
  /** Nombre que ve la persona. */
  label: string;
  vendor: string;
  protocol: AiProtocol;
  /** URL oficial; en los locales, la que se sugiere al administrador. */
  baseUrl: string;
  local: boolean;
  /** Dónde se consigue la clave. */
  keyUrl: string;
  keyPlaceholder: string;
};

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: "openai",
    label: "ChatGPT",
    vendor: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    local: false,
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "anthropic",
    label: "Claude",
    vendor: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    local: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
  {
    id: "xai",
    label: "Grok",
    vendor: "xAI",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    local: false,
    keyUrl: "https://console.x.ai",
    keyPlaceholder: "xai-…",
  },
  {
    id: "gemini",
    label: "Gemini",
    vendor: "Google",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    local: false,
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    vendor: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    local: false,
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "kimi",
    label: "Kimi",
    vendor: "Moonshot AI",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    local: false,
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "ollama",
    label: "Ollama",
    vendor: "Modelos abiertos",
    protocol: "ollama",
    baseUrl: "http://localhost:11434",
    local: true,
    keyUrl: "https://ollama.com/library",
    keyPlaceholder: "",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    vendor: "Modelos abiertos",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    keyUrl: "https://lmstudio.ai",
    keyPlaceholder: "",
  },
];

export const AI_PROVIDER_IDS = AI_PROVIDERS.map((provider) => provider.id) as [AiProviderId, ...AiProviderId[]];

export function aiProvider(id: string): AiProviderInfo | undefined {
  return AI_PROVIDERS.find((provider) => provider.id === id);
}

/** `ollama:llama3.2` → proveedor y modelo. */
export function splitModelRef(ref: string): { provider: AiProviderId; model: string } | null {
  const index = ref.indexOf(":");
  if (index <= 0) return null;
  const provider = aiProvider(ref.slice(0, index));
  const model = ref.slice(index + 1);
  return provider && model ? { provider: provider.id, model } : null;
}
