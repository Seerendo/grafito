import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import type { UserProfile } from "@/server/profile";
import { VaultError } from "@/server/vault";
import { openCorpus } from "./corpus.ts";
import type { VaultCaps } from "./access.ts";
import { accountTools } from "./tools/account.ts";
import { noteTools } from "./tools/notes.ts";
import { organizeTools } from "./tools/organize.ts";
import { tableTools } from "./tools/tables.ts";
import { graphTools } from "./tools/graph.ts";
import type { Tool } from "./tools/tool.ts";
import type { ToolCall, ToolSpec } from "./types.ts";

/**
 * The tools the MCP endpoint offers. The caller's role filters which ones exist; corpus.ts
 * enforces document access and write authorization on every call. Search uses server/index.
 */

export const ALL_TOOLS: Tool[] = [
  ...accountTools,
  ...noteTools,
  ...organizeTools,
  ...tableTools,
  ...graphTools,
];

function capsFor(profile: UserProfile): VaultCaps {
  const allows = (key: string) => profile.isAdmin || profile.permissions.includes(key);
  return {
    readOnly: false,
    editNotes: allows(PERMISSION.notesEdit),
    createNotes: allows(PERMISSION.notesCreate),
    managePortfolios: allows(PERMISSION.portfoliosManage),
  };
}

export type ToolOutcome = { text: string; isError: boolean };

export function vaultTools(
  sql: Sql,
  userId: string,
  profile: UserProfile,
): {
  tools: { spec: ToolSpec; writes: boolean; destructive: boolean }[];
  run: (call: ToolCall) => Promise<ToolOutcome>;
} {
  const corpus = openCorpus(sql, userId, capsFor(profile), `${profile.displayName} (MCP)`);
  const allowed = ALL_TOOLS.filter(
    (tool) => profile.isAdmin || profile.permissions.includes(tool.permission),
  );
  const context = { userId, profile };
  return {
    tools: allowed.map((tool) => ({
      spec: tool.spec,
      writes: Boolean(tool.writes),
      destructive: Boolean(tool.destructive),
    })),
    run: async (call) => {
      const tool = allowed.find((item) => item.spec.name === call.name);
      if (!tool) {
        return {
          text: JSON.stringify({ error: `Herramienta no disponible: ${call.name}` }),
          isError: true,
        };
      }
      try {
        const { result, event } = await tool.run(corpus, call.arguments, context);
        return { text: JSON.stringify(result), isError: !event.ok };
      } catch (error) {
        const message =
          error instanceof VaultError ? error.message : "Error al ejecutar la herramienta.";
        if (!(error instanceof VaultError)) console.error("[mcp]", call.name, error);
        return { text: JSON.stringify({ error: message }), isError: true };
      }
    },
  };
}
