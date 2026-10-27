import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { AI_PROVIDER_IDS, aiProvider, type AiProviderId } from "@/domain/ai";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { encryptionReady, EncryptionUnavailable } from "@/server/crypto";
import {
  AiUnavailable,
  deleteCredential,
  endpointFor,
  readCredentials,
  readPolicies,
  writeCredential,
  writePolicy,
} from "@/server/ai/config";
import { checkLocalUrl, localhostAlias } from "@/server/ai/local-url";
import { deleteConversation, listConversations, readConversation, writeConversation } from "@/server/ai/conversations";
import { listModels } from "@/server/ai/providers";
import { ProviderError } from "@/server/ai/types";

/** Administración → IA, Cuenta → IA y lo que el chat necesita saber. */

const providerId = z.enum(AI_PROVIDER_IDS);

async function caller(userId: string) {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return { sql, profile };
}

function problem(error: unknown): string {
  if (error instanceof AiUnavailable || error instanceof ProviderError || error instanceof EncryptionUnavailable) return error.message;
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(`${error.message} ${String(error.cause ?? "")}`)) {
    return "No se pudo conectar con el proveedor. Revisa la dirección o que el servicio esté encendido.";
  }
  console.error("[ai]", error);
  return "No se pudo hablar con el proveedor.";
}

// --- Administración ---------------------------------------------------------

export const aiAdminState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.manage")) return { ok: false as const };
    return { ok: true as const, providers: await readPolicies(sql), encryption: encryptionReady() };
  });

export const saveAiPolicy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: providerId, enabled: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.manage")) return { ok: false as const, error: "Sin permiso." };
    const info = aiProvider(data.id)!;
    await writePolicy(sql, data.id, data.enabled);
    await sql`
      insert into app_log (id, actor, area, message)
      values (${crypto.randomUUID()}, ${profile.loginName || profile.displayName}, 'IA',
        ${`${data.enabled ? "Permite" : "Retira"} ${info.label}`})
    `;
    return { ok: true as const };
  });

// --- Cuenta -----------------------------------------------------------------

export const aiAccountState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const };
    const policies = (await readPolicies(sql)).filter((policy) => policy.enabled);
    const credentials = await readCredentials(sql, context.userId);
    return {
      ok: true as const,
      encryption: encryptionReady(),
      providers: policies.map((policy) => ({
        id: policy.id,
        label: policy.label,
        vendor: policy.vendor,
        local: policy.local,
        keyUrl: policy.keyUrl,
        keyPlaceholder: policy.keyPlaceholder,
        suggestedUrl: policy.local ? policy.baseUrl : "",
        credential: credentials.find((item) => item.provider === policy.id) ?? null,
      })),
    };
  });

export const saveAiKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ provider: providerId, apiKey: z.string().max(500), baseUrl: z.string().max(300).default("") }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const, error: "Tu rol no puede usar la IA." };
    const policy = (await readPolicies(sql)).find((item) => item.id === data.provider);
    if (!policy?.enabled) return { ok: false as const, error: "El administrador no permite ese proveedor." };
    const key = data.apiKey.trim();
    if (!policy.local && !key) return { ok: false as const, error: "Pega tu clave." };
    let baseUrl = policy.baseUrl;
    let target = policy.baseUrl;
    if (policy.local) {
      // Instancia propia: se valida para que no apunte al servidor ni a sus servicios internos.
      const checked = checkLocalUrl(data.baseUrl, localhostAlias());
      if (!checked.ok) return { ok: false as const, error: checked.error };
      baseUrl = checked.url;
      target = checked.target;
    }
    try {
      // Se prueba antes de guardar: una conexión que no funciona no se guarda.
      const models = await listModels(policy.protocol, { baseUrl: target, apiKey: key });
      await writeCredential(sql, context.userId, data.provider, { apiKey: key, baseUrl: policy.local ? baseUrl : "" });
      return { ok: true as const, models };
    } catch (error) {
      return { ok: false as const, error: problem(error) };
    }
  });

export const removeAiKey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ provider: providerId }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql } = await caller(context.userId);
    await deleteCredential(sql, context.userId, data.provider);
    return { ok: true as const };
  });

// --- Chat -------------------------------------------------------------------

/** Proveedores listos para chatear (permitidos y conectados). */
export const aiChatState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const, providers: [] };
    const policies = (await readPolicies(sql)).filter((policy) => policy.enabled);
    const connected = new Set((await readCredentials(sql, context.userId)).map((item) => item.provider));
    return {
      ok: true as const,
      anyAllowed: policies.length > 0,
      providers: policies
        .filter((policy) => connected.has(policy.id))
        .map((policy) => ({ id: policy.id as AiProviderId, label: policy.label })),
    };
  });

export const aiModels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ provider: providerId }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const, error: "Sin permiso.", models: [] };
    try {
      const { policy, endpoint } = await endpointFor(sql, context.userId, data.provider);
      return { ok: true as const, models: await listModels(policy.protocol, endpoint) };
    } catch (error) {
      return { ok: false as const, error: problem(error), models: [] };
    }
  });

// --- Historial del chat -------------------------------------------------------

const conversationId = z.string().uuid();

const turn = z.object({
  id: z.string().max(64),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(200_000),
  tools: z.array(z.object({ label: z.string().max(300), ok: z.boolean(), docId: z.string().max(64).optional() })).max(40).optional(),
  error: z.string().max(2000).optional(),
});

export const aiConversations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const, conversations: [] };
    return { ok: true as const, conversations: await listConversations(sql, context.userId) };
  });

export const aiConversation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: conversationId }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const, error: "Sin permiso." };
    const conversation = await readConversation(sql, context.userId, data.id);
    if (!conversation) return { ok: false as const, error: "Esa conversación ya no existe." };
    const turns = z.array(turn).safeParse(conversation.turns);
    return { ok: true as const, title: conversation.title, turns: turns.success ? turns.data : [] };
  });

export const saveAiConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ id: conversationId, title: z.string().max(200), turns: z.array(turn).max(500) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { sql, profile } = await caller(context.userId);
    if (!allows(profile, "ai.use")) return { ok: false as const };
    const updatedAt = await writeConversation(sql, context.userId, data);
    return { ok: true as const, updatedAt };
  });

export const removeAiConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ id: conversationId }).parse(input))
  .handler(async ({ context, data }) => {
    const { sql } = await caller(context.userId);
    await deleteConversation(sql, context.userId, data.id);
    return { ok: true as const };
  });
