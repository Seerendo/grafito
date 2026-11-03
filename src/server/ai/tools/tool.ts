import { openCorpus, type ToolResult } from "../corpus.ts";
import type { ToolSpec } from "../types.ts";

export type ToolEvent = ToolResult["event"];

/** Tool contract: permission, mutation flag and execution. */
export type Tool = {
  spec: ToolSpec;
  permission: string;
  /** Mutation tools are excluded for read-only personas. */
  writes?: boolean;
  run: (
    corpus: ReturnType<typeof openCorpus>,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
};
