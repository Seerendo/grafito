import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AI_PROVIDER_IDS } from "@/domain/ai";
import { withMemory } from "@/domain/ai-context";
import { apiCaller, apiError, failure, readJson, requirePermission } from "@/server/api";
import { runAgent, type AgentEvent } from "@/server/ai/agent";
import { compressConversation } from "@/server/ai/compact";
import { AiUnavailable, endpointFor } from "@/server/ai/config";
import { readProfile } from "@/server/ai/profiles";
import { ndjsonResponse } from "@/server/ai/stream";
import { ProviderError } from "@/server/ai/types";

const body = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  model: z.string().min(1).max(200),
  profileId: z.string().uuid().optional(),
  messages: z
    .array(
      z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(40_000) }),
    )
    .min(1)
    .max(16),
  /** Compressed memory when recent turns do not cover the full conversation. */
  memory: z.string().max(2_000).optional(),
  /** Older turns requiring summarization before responding. */
  fold: z
    .object({
      prior: z.string().max(2_000),
      digest: z.string().min(1).max(8_000),
      untilId: z.string().min(1).max(64),
    })
    .optional(),
});

/**
 * POST /api/ai/chat accepts provider, model, messages and optional profileId, memory and fold.
 * NDJSON emits memory, tool, text, error or done events; done.changed indicates vault
 * mutations.
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
          // A persona deleted in another tab must not block the response.
          const persona = parsed.data.profileId
            ? await readProfile(caller.sql, caller.userId, parsed.data.profileId)
            : null;
          return ndjsonResponse<AgentEvent | { type: "memory"; text: string; untilId: string }>(
            request,
            async (emit, signal) => {
              try {
                let memory = parsed.data.memory?.trim() ?? "";
                const fold = parsed.data.fold;
                if (fold) {
                  const { policy, endpoint } = await endpointFor(
                    caller.sql,
                    caller.userId,
                    parsed.data.provider,
                  );
                  memory = await compressConversation({
                    protocol: policy.protocol,
                    endpoint,
                    model: parsed.data.model,
                    prior: fold.prior,
                    digest: fold.digest,
                    signal,
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
                  signal,
                  emit,
                });
              } catch (error) {
                const message =
                  error instanceof AiUnavailable || error instanceof ProviderError
                    ? error.message
                    : error instanceof Error && error.name === "AbortError"
                      ? "Cancelado."
                      : "No se pudo hablar con el proveedor. Revisa la dirección o la conexión.";
                if (!(error instanceof AiUnavailable || error instanceof ProviderError))
                  console.error("[ai]", error);
                emit({ type: "error", message });
              }
            },
            () => ({ type: "error", message: "No se pudo completar la respuesta." }),
          );
        } catch (error) {
          return failure(error);
        }
      },
    },
  },
});
