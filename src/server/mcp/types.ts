/** Tool definitions and calls as the MCP endpoint receives them. Relative imports allow direct Node tests. */

export type ToolCall = { name: string; arguments: Record<string, unknown> };

/** Simple JSON object schema with string, number and boolean properties. */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string" | "number" | "boolean"; description: string }>;
    required: string[];
  };
};
