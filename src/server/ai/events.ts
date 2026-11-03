/** Serializable events shared by the agent, chat service and HTTP transport. */
export type ToolEvent = { label: string; ok: boolean; docId?: string; changed?: boolean };

export type AgentEvent =
  | { type: "tool"; tool: string; event: ToolEvent }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; changed: boolean };

export type ChatEvent = AgentEvent | { type: "memory"; text: string; untilId: string };
