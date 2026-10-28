import type { Sql } from "@/lib/db";
import type { AiProviderId } from "@/domain/ai";
import type { UserProfile } from "@/server/profile";
import { endpointFor } from "./config.ts";
import type { AiProfile } from "./profiles.ts";
import { complete } from "./providers.ts";
import { vaultTools, type ToolEvent } from "./tools.ts";
import type { ChatMessage } from "./types.ts";

/**
 * El asistente: alterna llamadas al modelo y a las herramientas de la bóveda
 * hasta que el modelo responde sin pedir más herramientas (o se alcanza el
 * límite de pasos). Emite eventos para que el chat muestre el progreso.
 */

export type AgentEvent =
  | { type: "tool"; tool: string; event: ToolEvent }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; changed: boolean };

const MAX_STEPS = 8;

function systemPrompt(profile: UserProfile, toolNames: string[], persona: AiProfile | null): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "Eres el asistente de Grafito, una bóveda de notas en Markdown con portafolios (carpetas), archivos y enlaces [[Título]] entre notas.",
    `Hablas con ${profile.displayName}. Hoy es ${today}. Responde en el idioma de la persona, con Markdown breve y claro.`,
    toolNames.length
      ? `Puedes usar estas herramientas sobre su bóveda: ${toolNames.join(", ")}. Úsalas para leer de verdad antes de afirmar qué dice una nota; no inventes contenido. Cuando cites una nota, escribe su título como [[Título]].`
      : "No tienes acceso a la bóveda de esta persona; responde solo con lo que te escriba.",
    "Antes de crear o cambiar notas, asegúrate de que es lo que pidió. Al terminar, di qué hiciste (qué notas leíste, creaste o editaste).",
  ];
  // El perfil que eligió la persona: sus indicaciones van después de las del
  // asistente, así que mandan sobre el tono, el formato y el enfoque.
  if (persona) {
    lines.push(`Perfil activo: «${persona.name}».`);
    if (persona.readOnly) lines.push("Este perfil solo lee la bóveda: no puedes crear ni editar notas ni portafolios.");
    if (persona.instructions) lines.push(`Indicaciones de este perfil:\n${persona.instructions}`);
  }
  return lines.join("\n");
}

export async function runAgent(input: {
  sql: Sql;
  userId: string;
  profile: UserProfile;
  provider: AiProviderId;
  model: string;
  /** Perfil del chat elegido, si hay uno. */
  persona?: AiProfile | null;
  history: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}): Promise<void> {
  const { policy, endpoint } = await endpointFor(input.sql, input.userId, input.provider);
  const persona = input.persona ?? null;
  const tools = vaultTools(input.sql, input.userId, input.profile, { readOnly: persona?.readOnly ?? false });
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(input.profile, tools.specs.map((spec) => spec.name), persona) },
    ...input.history.map((message) => ({ role: message.role, content: message.content }) as ChatMessage),
  ];
  let changed = false;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (input.signal?.aborted) return;
    const completion = await complete(policy.protocol, {
      endpoint,
      model: input.model,
      messages,
      tools: tools.specs,
      signal: input.signal,
    });
    if (completion.toolCalls.length === 0) {
      input.emit({ type: "text", text: completion.text || "(sin respuesta)" });
      input.emit({ type: "done", changed });
      return;
    }
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      const { content, event } = await tools.run(call);
      if (event.changed) changed = true;
      input.emit({ type: "tool", tool: call.name, event });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
  input.emit({ type: "text", text: "Me detuve tras varios pasos con herramientas. Pídeme que continúe si hace falta." });
  input.emit({ type: "done", changed });
}
