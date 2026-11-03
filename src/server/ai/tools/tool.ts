import { openCorpus, type ToolResult } from "../corpus.ts";
import type { ToolSpec } from "../types.ts";

export type ToolEvent = ToolResult["event"];

/** Una herramienta: qué permiso pide, si escribe, y cómo se ejecuta. */
export type Tool = {
  spec: ToolSpec;
  permission: string;
  /** Crea o cambia algo: fuera en un perfil de solo lectura. */
  writes?: boolean;
  run: (
    corpus: ReturnType<typeof openCorpus>,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
};
