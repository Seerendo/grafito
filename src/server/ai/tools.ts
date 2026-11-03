import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import type { UserProfile } from "@/server/profile";
import { VaultError } from "@/server/vault";
import { openCorpus, type ToolResult } from "./corpus.ts";
import type { VaultCaps } from "./access.ts";
import { noteTools } from "./tools/notes.ts";
import { tableTools } from "./tools/tables.ts";
import type { Tool } from "./tools/tool.ts";
import type { ToolCall } from "./types.ts";

/**
 * Tools are grouped by notes/portfolios and tables. Roles and personas filter available tools;
 * corpus.ts enforces document access and write authorization. Search uses server/index.
 */

export type ToolEvent = ToolResult["event"];

function capsFor(profile: UserProfile, readOnly: boolean): VaultCaps {
  const allows = (key: string) => profile.isAdmin || profile.permissions.includes(key);
  return {
    readOnly,
    editNotes: allows(PERMISSION.notesEdit) && !readOnly,
    createNotes: allows(PERMISSION.notesCreate) && !readOnly,
    managePortfolios: allows(PERMISSION.portfoliosManage) && !readOnly,
  };
}

export function vaultTools(
  sql: Sql,
  userId: string,
  profile: UserProfile,
  options: { readOnly?: boolean } = {},
): {
  specs: Tool["spec"][];
  run: (call: ToolCall) => Promise<{ content: string; event: ToolEvent }>;
} {
  const readOnly = options.readOnly ?? false;
  const corpus = openCorpus(sql, userId, capsFor(profile, readOnly), `${profile.displayName} (IA)`);
  const tools: Tool[] = [...noteTools, ...tableTools];

  const allowed = tools.filter(
    (tool) =>
      (profile.isAdmin || profile.permissions.includes(tool.permission)) &&
      !(readOnly && tool.writes),
  );
  return {
    specs: allowed.map((tool) => tool.spec),
    run: async (call) => {
      const tool = allowed.find((item) => item.spec.name === call.name);
      if (!tool) {
        return {
          content: JSON.stringify({ error: `Herramienta no disponible: ${call.name}` }),
          event: { label: `Intentó «${call.name}» (no disponible)`, ok: false },
        };
      }
      try {
        const { result, event } = await tool.run(corpus, call.arguments);
        return { content: JSON.stringify(result), event };
      } catch (error) {
        const message =
          error instanceof VaultError ? error.message : "Error al ejecutar la herramienta.";
        return {
          content: JSON.stringify({ error: message }),
          event: { label: message, ok: false },
        };
      }
    },
  };
}
