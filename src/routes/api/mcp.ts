import { createFileRoute } from "@tanstack/react-router";
import { PERMISSION } from "@/domain/permissions";
import { resolveToken, TOKEN_PREFIX } from "@/server/api-tokens";
import { apiError, json } from "@/server/api";
import { handleMcp } from "@/server/mcp/protocol";
import { vaultTools } from "@/server/mcp/tools";
import { readUserProfile } from "@/server/profile";

const MAX_BODY = 1024 * 1024;

function unauthorized(message: string): Response {
  const response = apiError(401, message);
  response.headers.set("www-authenticate", 'Bearer realm="grafito"');
  return response;
}

/**
 * POST /api/mcp: the MCP server (Streamable HTTP, JSON answers). Only a personal gft_ token
 * signs in, so a browser session cannot be used from another site; its role decides the tools.
 */
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const header = request.headers.get("authorization") ?? "";
          const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
          if (!bearer.startsWith(TOKEN_PREFIX))
            return unauthorized("Usa un token personal (Cuenta → API) como Bearer.");
          const { getSql } = await import("@/lib/db");
          const sql = await getSql();
          const userId = await resolveToken(sql, bearer);
          if (!userId) return unauthorized("Token no válido.");
          const profile = await readUserProfile(sql, userId);
          if (!profile.isAdmin && !profile.permissions.includes(PERMISSION.apiUse))
            return apiError(403, "Tu rol no puede usar la API.");
          const raw = await request.text();
          if (raw.length > MAX_BODY) return apiError(413, "La petición es demasiado grande.");
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            return json(
              { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
              400,
            );
          }
          const tools = vaultTools(sql, userId, profile);
          const answer = await handleMcp(
            { version: "1", tools: tools.tools, call: tools.run },
            body,
          );
          if (!answer) return new Response(null, { status: 202 });
          return json(answer);
        } catch (error) {
          console.error("[mcp]", error);
          return apiError(500, "Error interno.");
        }
      },
      GET: () => new Response(null, { status: 405, headers: { allow: "POST" } }),
      DELETE: () => new Response(null, { status: 405, headers: { allow: "POST" } }),
    },
  },
});
