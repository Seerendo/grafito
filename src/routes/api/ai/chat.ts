import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AI_PROVIDER_IDS } from "@/domain/ai";
import { apiCaller, apiError, failure, readJson, requirePermission } from "@/server/api";
import { runAgent, type AgentEvent } from "@/server/ai/agent";
import { AiUnavailable } from "@/server/ai/config";
import { ProviderError } from "@/server/ai/types";

const body = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  model: z.string().min(1).max(200),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(40_000) }))
    .min(1)
    .max(60),
});

/**
 * `POST /api/ai/chat` con `{ provider, model, messages }`. Responde con NDJSON
 * (un evento JSON por línea): `tool` por cada herramienta usada, `text` con la
 * respuesta, `error` o `done` (con `changed` si la bóveda cambió).
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
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const emit = (event: AgentEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              try {
                await runAgent({
                  sql: caller.sql,
                  userId: caller.userId,
                  profile: caller.profile,
                  provider: parsed.data.provider,
                  model: parsed.data.model,
                  history: parsed.data.messages,
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
