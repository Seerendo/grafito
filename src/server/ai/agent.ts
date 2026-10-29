import type { Sql } from "@/lib/db";
import type { AiProviderId } from "@/domain/ai";
import type { UserProfile } from "@/server/profile";
import { endpointFor } from "./config.ts";
import type { AiProfile } from "./profiles.ts";
import { complete } from "./providers.ts";
import { vaultTools, type ToolEvent } from "./tools.ts";
import { CLAIMS_WRITE, compactToolResults, WRITE_TOOLS } from "./guard.ts";
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
    "Solo existe lo que hacen las herramientas: para crear, editar o guardar algo tienes que llamar a la herramienta y recibir su resultado sin error. Nunca digas que creaste, editaste o guardaste algo si no lo hiciste así en esta respuesta; si una herramienta falló, dilo.",
    "En la conversación, lo que hiciste en cada respuesta anterior aparece entre corchetes («[Acciones: …]»): es lo que de verdad pasó.",
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
  // Escrituras que salieron bien en esta respuesta (crear, editar).
  let wrote = 0;
  let checked = false;
  const canWrite = tools.specs.some((spec) => WRITE_TOOLS.has(spec.name));
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (input.signal?.aborted) return;
    compactToolResults(messages);
    const completion = await complete(policy.protocol, {
      endpoint,
      model: input.model,
      messages,
      tools: tools.specs,
      signal: input.signal,
    });
    if (completion.toolCalls.length === 0) {
      const text = completion.text || "(sin respuesta)";
      // Dice que creó o cambió algo sin haberlo hecho: una oportunidad para
      // hacerlo de verdad o corregirse; si insiste, se avisa a la persona.
      if (canWrite && wrote === 0 && CLAIMS_WRITE.test(text)) {
        if (!checked) {
          checked = true;
          messages.push({ role: "assistant", content: text });
          messages.push({
            role: "user",
            content:
              "(Comprobación automática de Grafito, no la escribió la persona.) En esta respuesta no se creó ni se cambió nada: ninguna herramienta que escribe se llamó con éxito. Si la persona lo pidió, hazlo ahora llamando a la herramienta. Si no, responde de nuevo sin decir que lo hiciste.",
          });
          continue;
        }
        input.emit({
          type: "text",
          text: `${text}\n\n> **Ojo:** en esta respuesta no se creó ni se cambió nada en la bóveda, aunque el texto lo diga.`,
        });
        input.emit({ type: "done", changed });
        return;
      }
      input.emit({ type: "text", text });
      input.emit({ type: "done", changed });
      return;
    }
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      const { content, event } = await tools.run(call);
      if (event.changed) changed = true;
      if (event.ok && WRITE_TOOLS.has(call.name)) wrote += 1;
      input.emit({ type: "tool", tool: call.name, event });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
  input.emit({ type: "text", text: "Me detuve tras varios pasos con herramientas. Pídeme que continúe si hace falta." });
  input.emit({ type: "done", changed });
}
