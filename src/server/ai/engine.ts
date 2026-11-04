import { CLAIMS_WRITE, compactToolResults, WRITE_TOOLS } from "./guard.ts";
import type { AgentEvent, ToolEvent } from "./events.ts";
import type { ChatMessage, Completion, ToolCall, ToolSpec } from "./types.ts";

/** Ports keep the execution loop independent of SQL, HTTP and provider credentials. */
export type AgentTools = {
  specs: ToolSpec[];
  run: (call: ToolCall) => Promise<{ content: string; event: ToolEvent }>;
};

export type AgentInput = {
  messages: ChatMessage[];
  tools: AgentTools;
  complete: (messages: ChatMessage[], tools: ToolSpec[]) => Promise<Completion>;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
};

const MAX_STEPS = 8;

/** Run tools sequentially: later calls may depend on earlier writes. */
export async function executeAgent(input: AgentInput): Promise<void> {
  const { messages, tools, signal, emit } = input;
  let changed = false;
  let wrote = 0;
  let checked = false;
  const canWrite = tools.specs.some((spec) => WRITE_TOOLS.has(spec.name));
  for (let step = 0; step < MAX_STEPS; step += 1) {
    signal?.throwIfAborted();
    compactToolResults(messages);
    const completion = await input.complete(messages, tools.specs);
    signal?.throwIfAborted();
    if (completion.toolCalls.length === 0) {
      const text = completion.text || "(sin respuesta)";
      // Allow one correction when the model claims a write that never succeeded.
      if (canWrite && wrote === 0 && CLAIMS_WRITE.test(text)) {
        if (!checked) {
          checked = true;
          messages.push({ role: "assistant", content: text });
          messages.push({
            role: "user",
            content:
              "(Comprobación automática de Grafito, no la escribió la persona.) En esta respuesta no se creó, ni se cambió, ni se vinculó nada: ninguna herramienta que escribe se llamó con éxito. Si la persona lo pidió, hazlo ahora llamando a la herramienta. Si no, responde de nuevo sin decir que lo hiciste.",
          });
          continue;
        }
        emit({
          type: "text",
          text: `${text}\n\n> **Ojo:** en esta respuesta no se creó, ni se cambió, ni se vinculó nada en la bóveda, aunque el texto lo diga.`,
        });
        emit({ type: "done", changed });
        return;
      }
      emit({ type: "text", text });
      emit({ type: "done", changed });
      return;
    }
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      // Cancellation must also stop the remaining writes in a multi-tool response.
      signal?.throwIfAborted();
      const { content, event } = await tools.run(call);
      if (event.changed) changed = true;
      if (event.ok && WRITE_TOOLS.has(call.name)) wrote += 1;
      emit({ type: "tool", tool: call.name, event });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
  emit({
    type: "text",
    text: "Me detuve tras varios pasos con herramientas. Pídeme que continúe si hace falta.",
  });
  emit({ type: "done", changed });
}
