import type { Sql } from "@/lib/db";
import { AI_PROVIDERS, aiProvider, type AiProviderId, type AiProviderInfo } from "@/domain/ai";
import { encrypt, open } from "@/server/crypto";
import { checkLocalUrl } from "./local-url.ts";
import type { Endpoint } from "./types.ts";

/**
 * Configuración de la IA (solo servidor): qué proveedores permite el
 * administrador y la conexión de cada usuario. En los de la nube, su clave
 * (cifrada con `server/crypto.ts`) contra la URL oficial; en Ollama y LM
 * Studio, la dirección de su propia instancia (validada con `local-url.ts`) y
 * una clave opcional.
 */

export type ProviderPolicy = AiProviderInfo & { enabled: boolean };

function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export async function readPolicies(sql: Sql): Promise<ProviderPolicy[]> {
  const rows = await sql<{ id: string; enabled: unknown }>`select id, enabled from ai_provider`;
  return AI_PROVIDERS.map((provider) => ({
    ...provider,
    enabled: flag(rows.find((item) => item.id === provider.id)?.enabled),
  }));
}

export async function writePolicy(sql: Sql, id: AiProviderId, enabled: boolean): Promise<void> {
  await sql`
    insert into ai_provider (id, enabled) values (${id}, ${enabled})
    on conflict (id) do update set enabled = excluded.enabled
  `;
}

export type CredentialView = { provider: AiProviderId; hint: string; baseUrl: string; updatedAt: string };

export async function readCredentials(sql: Sql, userId: string): Promise<CredentialView[]> {
  const rows = await sql<{ provider: string; key_hint: string; base_url: string; updated_at: unknown }>`
    select provider, key_hint, base_url, updated_at from ai_credential where user_id = ${userId}
  `;
  return rows
    .filter((row) => aiProvider(row.provider))
    .map((row) => ({
      provider: row.provider as AiProviderId,
      hint: row.key_hint,
      baseUrl: row.base_url,
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }));
}

/** Guarda la conexión: clave cifrada (si la hay) y, en los locales, la dirección. */
export async function writeCredential(
  sql: Sql,
  userId: string,
  provider: AiProviderId,
  input: { apiKey: string; baseUrl: string },
): Promise<void> {
  const sealed = input.apiKey ? encrypt(input.apiKey) : "";
  const hint = input.apiKey ? `…${input.apiKey.slice(-4)}` : "";
  await sql`
    insert into ai_credential (user_id, provider, api_key, key_hint, base_url, updated_at)
    values (${userId}, ${provider}, ${sealed}, ${hint}, ${input.baseUrl}, now())
    on conflict (user_id, provider) do update set
      api_key = excluded.api_key, key_hint = excluded.key_hint, base_url = excluded.base_url, updated_at = now()
  `;
}

export async function deleteCredential(sql: Sql, userId: string, provider: AiProviderId): Promise<void> {
  await sql`delete from ai_credential where user_id = ${userId} and provider = ${provider}`;
}

export class AiUnavailable extends Error {}

/**
 * Dirección y clave para llamar a `provider` en nombre de `userId`. Falla si
 * el administrador no lo permite o el usuario no lo ha conectado.
 */
export async function endpointFor(sql: Sql, userId: string, provider: AiProviderId): Promise<{ policy: ProviderPolicy; endpoint: Endpoint }> {
  const policy = (await readPolicies(sql)).find((item) => item.id === provider);
  if (!policy?.enabled) throw new AiUnavailable("El administrador no tiene activado ese proveedor.");
  const rows = await sql<{ api_key: string; base_url: string }>`
    select api_key, base_url from ai_credential where user_id = ${userId} and provider = ${provider} limit 1
  `;
  if (!rows[0]) throw new AiUnavailable(`Conecta ${policy.label} en tu cuenta (Cuenta → IA).`);
  let apiKey = "";
  if (rows[0].api_key) {
    const opened = open(rows[0].api_key);
    apiKey = opened.value;
    // Rotación de GRAFITO_ENCRYPTION_KEY: se vuelve a cifrar con la clave nueva.
    if (opened.stale) {
      await sql`update ai_credential set api_key = ${encrypt(apiKey)} where user_id = ${userId} and provider = ${provider}`;
    }
  }
  if (!policy.local) {
    if (!apiKey) throw new AiUnavailable(`Falta tu clave de ${policy.label}.`);
    return { policy, endpoint: { baseUrl: policy.baseUrl, apiKey } };
  }
  // Se vuelve a validar al usarla: la lista de direcciones prohibidas puede haber crecido.
  const checked = checkLocalUrl(rows[0].base_url);
  if (!checked.ok) throw new AiUnavailable(`${checked.error} Revísala en Cuenta → IA.`);
  return { policy, endpoint: { baseUrl: checked.url, apiKey } };
}
