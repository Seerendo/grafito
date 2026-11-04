import type { Sql } from "@/lib/db";
import type { AiProviderId } from "@/domain/ai";
import type { UserProfile } from "@/server/profile";
import { endpointFor } from "./config.ts";
import type { AiProfile } from "./profiles.ts";
import { complete } from "./providers.ts";
import { vaultTools } from "./tools.ts";
import { executeAgent } from "./engine.ts";
import type { AgentEvent } from "./events.ts";
export type { AgentEvent } from "./events.ts";
import type { ChatMessage } from "./types.ts";

/**
 * Compose the assistant's provider, prompt and authorized tools. The bounded engine alternates
 * completions and tool calls while emitting progress events.
 */

function systemPrompt(
  profile: UserProfile,
  toolNames: string[],
  persona: AiProfile | null,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "Eres el asistente de Grafito, una bóveda de notas en Markdown con portafolios (carpetas), archivos y enlaces [[Título]] entre notas.",
    `Hablas con ${profile.displayName}. Hoy es ${today}. Responde en el idioma de la persona, con Markdown breve y claro.`,
    toolNames.length
      ? `Puedes usar estas herramientas: ${toolNames.join(", ")}. Úsalas para leer de verdad antes de afirmar qué dice una nota; no inventes contenido. Cuando cites una nota, escribe su título como [[Título]].`
      : "No tienes acceso a la bóveda de esta persona; responde solo con lo que te escriba.",
    ...(toolNames.includes("search_notes")
      ? [
          "search_notes busca la frase exacta en notas, tablas y archivos (PDF, Word .docx, Excel, PowerPoint y OpenDocument). Solo aparecen documentos donde esa frase está escrita, con un fragmento por cada vez. Úsala para encontrar algo por lo que dice, no solo por el nombre. El .doc antiguo no entra en ese índice.",
        ]
      : []),
    "Solo ves lo que esta persona puede abrir: su Carpeta Personal, lo que le compartieron y las carpetas de espacios de trabajo que le concedieron. El acceso de un documento dice si puedes editarlo; el de un portafolio, si puedes crear dentro. No edites un documento de lectura ni crees en un portafolio de lectura. Si la herramienta lo rechaza, explícalo y no inventes el cambio.",
    ...(toolNames.includes("link_pdf_phrase")
      ? [
          "Para vincular una frase o una palabra de un PDF con otro documento usa link_pdf_phrase. El vínculo queda en ese PDF, en esa frase, igual que al seleccionarla a mano. No crees una nota Markdown intermedia para eso. Si la frase está en varias páginas, la herramienta te pide el número; vuelve a llamarla con page. Si el PDF no tiene texto, dilo y no inventes el vínculo. [[Título]] sigue siendo solo para enlazar notas.",
        ]
      : []),
    "Antes de crear o cambiar notas, asegúrate de que es lo que pidió. Al terminar, di qué hiciste (qué notas leíste, creaste, editaste o vinculaste).",
    "Solo existe lo que hacen las herramientas: para crear, editar, guardar o vincular algo tienes que llamar a la herramienta y recibir su resultado sin error. Nunca digas que creaste, editaste, guardaste o vinculaste algo si no lo hiciste así en esta respuesta; si una herramienta falló, dilo.",
    "En la conversación, lo que hiciste en cada respuesta anterior aparece entre corchetes («[Acciones: …]»): es lo que de verdad pasó.",
    "Si el primer mensaje es una memoria entre corchetes, Grafito comprimió ahí lo ya hablado para no reenviar el historial. Úsala como antecedente y no la contestes.",
  ];
  // Append the selected persona's instructions to control tone, format and focus.
  if (persona) {
    lines.push(`Perfil activo: «${persona.name}».`);
    if (persona.readOnly)
      lines.push(
        "Este perfil solo lee la bóveda: no puedes crear ni editar notas ni portafolios, ni vincular frases de un PDF.",
      );
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
  /** Optional selected chat persona. */
  persona?: AiProfile | null;
  history: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}): Promise<void> {
  const { policy, endpoint } = await endpointFor(input.sql, input.userId, input.provider);
  const persona = input.persona ?? null;
  const tools = vaultTools(input.sql, input.userId, input.profile, {
    readOnly: persona?.readOnly ?? false,
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt(
        input.profile,
        tools.specs.map((spec) => spec.name),
        persona,
      ),
    },
    ...input.history.map(
      (message) => ({ role: message.role, content: message.content }) as ChatMessage,
    ),
  ];
  await executeAgent({
    messages,
    tools,
    signal: input.signal,
    emit: input.emit,
    complete: (messages, specs) =>
      complete(policy.protocol, {
        endpoint,
        model: input.model,
        messages,
        tools: specs,
        signal: input.signal,
      }),
  });
}
