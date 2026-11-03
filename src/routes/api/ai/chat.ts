import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AI_PROVIDER_IDS } from "@/domain/ai";
import { withMemory } from "@/domain/ai-context";
import { apiCaller, apiError, failure, readJson, requirePermission } from "@/server/api";
import { runAgent, type AgentEvent } from "@/server/ai/agent";
import { compressConversation } from "@/server/ai/compact";
import { AiUnavailable, endpointFor } from "@/server/ai/config";
import { readProfile } from "@/server/ai/profiles";
import { ProviderError } from "@/server/ai/types";

const body = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  model: z.string().min(1).max(200),
  profileId: z.string().uuid().optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(40_000) }))
    .min(1)
    .max(16),
  /** Memoria ya comprimida, si los turnos recientes no son toda la conversación. */
  memory: z.string().max(2_000).optional(),
  /** Turnos viejos que hay que resumir antes de responder. */
  fold: z
    .object({
      prior: z.string().max(2_000),
      digest: z.string().min(1).max(8_000),
      untilId: z.string().min(1).max(64),
    })
    .optional(),
});

/**
 * `POST /api/ai/chat` con `{ provider, model, messages, profileId?, memory?, fold? }`.
 * Responde con NDJSON (un evento JSON por línea): `memory` si se comprimió el
 * historial, `tool` por cada herramienta usada, `text` con la respuesta,
 * `error` o `done` (con `changed` si la bóveda cambió).
 */
export const Route = createFileRoute("/api/ai/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const caller = await apiCaller(request);
          requirePermission(caller.profile, "ai.use", "Tu rol no puede usar la IA.");
          const parsed = body.safeParse(await readJson(request));
          if (!parsed.success) return apiError(400, "Se espera { provider, model, messages }.");
          // Un perfil que ya no existe (borrado en otra pestaña) no impide responder.
          const persona = parsed.data.profileId ? await readProfile(caller.sql, caller.userId, parsed.data.profileId) : null;
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const emit = (event: AgentEvent | { type: "memory"; text: string; untilId: string }) =>
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              try {
                let memory = parsed.data.memory?.trim() ?? "";
                const fold = parsed.data.fold;
                if (fold) {
                  const { policy, endpoint } = await endpointFor(caller.sql, caller.userId, parsed.data.provider);
                  memory = await compressConversation({
                    protocol: policy.protocol,
                    endpoint,
                    model: parsed.data.model,
                    prior: fold.prior,
                    digest: fold.digest,
                    signal: request.signal,
                  });
                  emit({ type: "memory", text: memory, untilId: fold.untilId });
                }
                await runAgent({
                  sql: caller.sql,
                  userId: caller.userId,
                  profile: caller.profile,
                  provider: parsed.data.provider,
                  model: parsed.data.model,
                  persona,
                  history: withMemory(memory, parsed.data.messages),
                  signal: request.signal,
                  emit,
                });
              } catch (error) {
                const message =
                  error instanceof AiUnavailable || error instanceof ProviderError
                    ? error.message
                    : error instanceof Error && error.name === "AbortError"
                      ? "Cancelado."
                      : "No se pudo hablar con el proveedor. Revisa la dirección o la conexión.";
                if (!(error instanceof AiUnavailable || error instanceof ProviderError)) console.error("[ai]", error);
                emit({ type: "error", message });
              } finally {
                controller.close();
              }
            },
          });
          return new Response(stream, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
          });
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
