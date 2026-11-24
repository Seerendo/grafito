import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmsName } from "../../../src/server/mcp/access.ts";
import { handleMcp, PROTOCOL_VERSIONS, type McpServer } from "../../../src/server/mcp/protocol.ts";

/** MCP over HTTP: the JSON-RPC answers Grafito gives, and the confirmation for deletions. */

const calls: { name: string; arguments: Record<string, unknown> }[] = [];
const server: McpServer = {
  version: "1",
  tools: [
    {
      spec: {
        name: "read_note",
        description: "Lee",
        parameters: { type: "object", properties: {}, required: [] },
      },
      writes: false,
      destructive: false,
    },
    {
      spec: {
        name: "delete_note",
        description: "Borra",
        parameters: { type: "object", properties: {}, required: [] },
      },
      writes: true,
      destructive: true,
    },
  ],
  call: (call) => {
    calls.push(call);
    return Promise.resolve({ text: JSON.stringify({ ok: call.name }), isError: false });
  },
};

test("initialize acepta la versión que pide el cliente, o propone la más reciente", async () => {
  const known = (await handleMcp(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {} },
  })) as {
    result: { protocolVersion: string; capabilities: object; serverInfo: { name: string } };
  };
  assert.equal(known.result.protocolVersion, "2025-03-26");
  assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
  assert.equal(known.result.serverInfo.name, "grafito");
  const unknown = (await handleMcp(server, {
    jsonrpc: "2.0",
    id: "a",
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  })) as { id: string; result: { protocolVersion: string } };
  assert.equal(unknown.id, "a");
  assert.equal(unknown.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test("las notificaciones no tienen respuesta", async () => {
  assert.equal(
    await handleMcp(server, { jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
  );
  assert.equal(
    await handleMcp(server, [{ jsonrpc: "2.0", method: "notifications/initialized" }]),
    null,
  );
});

test("tools/list describe cada herramienta con sus anotaciones", async () => {
  const listed = (await handleMcp(server, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
    result: {
      tools: {
        name: string;
        inputSchema: object;
        annotations: { readOnlyHint: boolean; destructiveHint: boolean };
      }[];
    };
  };
  const [read, remove] = listed.result.tools;
  assert.equal(read?.name, "read_note");
  assert.deepEqual(read?.inputSchema, { type: "object", properties: {}, required: [] });
  assert.equal(read?.annotations.readOnlyHint, true);
  assert.equal(remove?.annotations.readOnlyHint, false);
  assert.equal(remove?.annotations.destructiveHint, true);
});

test("tools/call ejecuta la herramienta; una desconocida o un método desconocido son errores", async () => {
  calls.length = 0;
  const done = (await handleMcp(server, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "read_note", arguments: { id: "Atlas" } },
  })) as { result: { content: { type: string; text: string }[]; isError: boolean } };
  assert.deepEqual(calls, [{ name: "read_note", arguments: { id: "Atlas" } }]);
  assert.deepEqual(done.result.content, [{ type: "text", text: '{"ok":"read_note"}' }]);
  assert.equal(done.result.isError, false);
  const missing = (await handleMcp(server, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "create_note" },
  })) as { error: { code: number } };
  assert.equal(missing.error.code, -32602);
  assert.equal(calls.length, 1);
  const method = (await handleMcp(server, { jsonrpc: "2.0", id: 5, method: "resources/list" })) as {
    error: { code: number };
  };
  assert.equal(method.error.code, -32601);
  const bad = (await handleMcp(server, { id: 6, method: "ping" })) as { error: { code: number } };
  assert.equal(bad.error.code, -32600);
});

test("un lote responde a cada petición y omite las notificaciones", async () => {
  const answers = (await handleMcp(server, [
    { jsonrpc: "2.0", id: 7, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 8, method: "ping" },
  ])) as { id: number; result: object }[];
  assert.deepEqual(
    answers.map((answer) => answer.id),
    [7, 8],
  );
});

test("eliminar exige repetir el nombre exacto en confirm", () => {
  assert.equal(confirmsName("Acta de junio", "Acta de junio"), true);
  assert.equal(confirmsName("  acta  DE junio ", "Acta de junio"), true);
  assert.equal(confirmsName("sí", "Acta de junio"), false);
  assert.equal(confirmsName("Acta de junio y más", "Acta de junio"), false);
  assert.equal(confirmsName("", ""), false);
});
