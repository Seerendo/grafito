import { openCorpus, type ToolResult } from "../corpus.ts";
import type { ToolSpec } from "../types.ts";

export type ToolEvent = ToolResult["event"];

/** What a tool may touch beyond the vault: the caller's identity, for whoami. */
export type ToolContext = {
  userId: string;
  profile: { displayName: string; loginName: string; roleName: string; permissions: string[] };
};

/** Tool contract: permission, mutation flags and execution. */
export type Tool = {
  spec: ToolSpec;
  permission: string;
  /** Creates or changes content. */
  writes?: boolean;
  /** Sends something to the trash or removes it; MCP clients ask before calling it. */
  destructive?: boolean;
  run: (
    corpus: ReturnType<typeof openCorpus>,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
};
