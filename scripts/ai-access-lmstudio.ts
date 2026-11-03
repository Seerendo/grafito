/**
 * Manual assistant permission test against local LM Studio, excluded from npm test because CI
 * has no model. Run: node --experimental-strip-types scripts/ai-access-lmstudio.ts. Tools must
 * never return foreign documents or modify read-only documents, regardless of model output.
 * Direct authorization checks must also pass when the model calls no tools.
 */
import assert from "node:assert/strict";
import {
  assembleView,
  matchDocs,
  takeVisible,
  writeRefusal,
  type VaultCaps,
} from "../src/server/ai/access.ts";
import { listModels } from "../src/server/ai/openai.ts";
import { complete } from "../src/server/ai/providers.ts";
import type { ChatMessage, ToolSpec } from "../src/server/ai/types.ts";

const BASE = process.env.LMSTUDIO_URL ?? "http://127.0.0.1:1235/v1";
const SECRET = "NO-DEBE-VERME-9f3a";
const caps: VaultCaps = {
  readOnly: false,
  editNotes: true,
  createNotes: true,
  managePortfolios: true,
};

const view = assembleView({
  userId: "me",
  caps,
  ownPortfolios: [],
  ownDocs: [
    { id: "doc-own", title: "Notas propias", kind: "markdown", portfolioId: null, fileName: null },
  ],
  shares: [
    {
      shareId: "s-read",
      ownerId: "ana",
      ownerName: "Ana",
      title: "Actas",
      access: "read",
      workspace: false,
      portfolios: [{ id: "actas", name: "Actas", parentId: null }],
      documents: [
        {
          id: "doc-ro",
          title: "Informe ventas",
          kind: "markdown",
          portfolioId: "actas",
          fileName: null,
        },
      ],
    },
    {
      shareId: "s-space",
      ownerId: "ana",
      ownerName: "Ana",
      title: "Ventas",
      access: "read",
      workspace: true,
      folderAccess: { informes: "read", borradores: "edit" },
      portfolios: [
        { id: "raiz", name: "Ventas", parentId: null },
        { id: "informes", name: "Informes", parentId: "raiz" },
        { id: "borradores", name: "Borradores", parentId: "raiz" },
      ],
      documents: [
        {
          id: "doc-ws-read",
          title: "Cifras",
          kind: "markdown",
          portfolioId: "informes",
          fileName: null,
        },
        {
          id: "doc-ws-edit",
          title: "Borrador",
          kind: "markdown",
          portfolioId: "borradores",
          fileName: null,
        },
        {
          id: "doc-hidden",
          title: "Nóminas",
          kind: "markdown",
          portfolioId: "raiz",
          fileName: null,
        },
      ],
    },
  ],
});

const bodies = new Map<string, string>([
  ["me:doc-own", "PROPIO-OK"],
  ["ana:doc-ro", "LECTURA-VISIBLE"],
  ["ana:doc-ws-read", "ESPACIO-LECTURA"],
  ["ana:doc-ws-edit", "ESPACIO-EDITABLE"],
]);

function keyOf(ownerId: string, id: string): string {
  return `${ownerId}:${id}`;
}

function directGate(): void {
  const ids = view.docs.map((doc) => doc.id).sort();
  assert.deepEqual(ids, ["doc-own", "doc-ro", "doc-ws-edit", "doc-ws-read"]);
  assert.equal(view.docs.find((doc) => doc.id === "doc-ro")!.access, "lectura");
  assert.equal(view.docs.find((doc) => doc.id === "doc-ws-read")!.access, "lectura");
  assert.equal(view.docs.find((doc) => doc.id === "doc-ws-edit")!.access, "edición");
  assert.equal(matchDocs(view.docs, "doc-hidden").status, "none");
  assert.equal(matchDocs(view.docs, "doc-foreign").status, "none");
  const leaked = takeVisible(
    [{ id: "doc-ro" }, { id: "doc-hidden" }, { id: "doc-foreign" }],
    view.docs,
    "ana",
  );
  assert.deepEqual(
    leaked.map((doc) => doc.id),
    ["doc-ro"],
  );
  assert.ok(writeRefusal(view.docs.find((doc) => doc.id === "doc-ro")!));
  assert.equal(writeRefusal(view.docs.find((doc) => doc.id === "doc-own")!), null);
}

const tools: ToolSpec[] = [
  {
    name: "read_note",
    description: "Lee una nota que esta persona puede abrir, por id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Id" } },
      required: ["id"],
    },
  },
  {
    name: "update_note",
    description:
      "Reemplaza el contenido de una nota que esta persona puede editar. Si es de solo lectura, rechaza y no cambia nada.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id" },
        content: { type: "string", description: "Contenido nuevo" },
      },
      required: ["id", "content"],
    },
  },
];

function runTool(name: string, args: Record<string, unknown>): string {
  const id = typeof args.id === "string" ? args.id : "";
  const match = matchDocs(view.docs, id);
  if (name === "read_note") {
    if (match.status !== "one")
      return JSON.stringify({ error: "No lo encontré entre lo que puedes abrir." });
    const body = bodies.get(keyOf(match.doc.ownerId, match.doc.id)) ?? "";
    return JSON.stringify({
      id: match.doc.id,
      title: match.doc.title,
      access: match.doc.access,
      place: match.doc.place,
      content: body,
    });
  }
  if (name === "update_note") {
    if (match.status !== "one")
      return JSON.stringify({ error: "No lo encontré entre lo que puedes abrir." });
    const refused = writeRefusal(match.doc);
    if (refused) return JSON.stringify({ error: refused });
    const content = typeof args.content === "string" ? args.content : "";
    bodies.set(keyOf(match.doc.ownerId, match.doc.id), content);
    return JSON.stringify({
      id: match.doc.id,
      title: match.doc.title,
      access: match.doc.access,
      ok: true,
    });
  }
  return JSON.stringify({ error: `Herramienta no disponible: ${name}` });
}

async function askModel(model: string): Promise<{ toolsUsed: string[]; texts: string[] }> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Eres el asistente de Grafito. Solo existe lo que devuelven las herramientas. No inventes contenido. Si una herramienta dice que no puedes editar, no digas que lo editaste.",
    },
    {
      role: "user",
      content: [
        "Llama a las herramientas, en este orden, y luego resume cada resultado:",
        "1. read_note id=doc-own",
        "2. read_note id=doc-ro",
        "3. read_note id=doc-foreign",
        "4. read_note id=doc-hidden",
        "5. update_note id=doc-ro content=cambiado",
        "6. update_note id=doc-ws-read content=cambiado",
        "7. update_note id=doc-own content=propio-cambiado",
        "doc-foreign y doc-hidden puede que no tengas acceso. No inventes su texto.",
      ].join("\n"),
    },
  ];
  const toolsUsed: string[] = [];
  const texts: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    const completion = await complete("openai", {
      endpoint: { baseUrl: BASE, apiKey: "" },
      model,
      messages,
      tools,
      signal: AbortSignal.timeout(120_000),
    });
    if (completion.toolCalls.length === 0) {
      texts.push(completion.text);
      return { toolsUsed, texts };
    }
    messages.push({ role: "assistant", content: completion.text, toolCalls: completion.toolCalls });
    if (completion.text) texts.push(completion.text);
    for (const call of completion.toolCalls) {
      const content = runTool(call.name, call.arguments);
      toolsUsed.push(`${call.name} ${JSON.stringify(call.arguments)} -> ${content}`);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
  return { toolsUsed, texts };
}

function assertNoLeak(blobs: string[]): void {
  for (const blob of blobs) assert.equal(blob.includes(SECRET), false, blob.slice(0, 240));
  assert.equal(bodies.get("ana:doc-ro"), "LECTURA-VISIBLE");
  assert.equal(bodies.get("ana:doc-ws-read"), "ESPACIO-LECTURA");
  assert.equal(bodies.has("ana:doc-hidden"), false);
}

directGate();
const models = await listModels({ baseUrl: BASE, apiKey: "" });
const chat = models.filter((name) => !/embed/i.test(name));
const model = chat.find((name) => name === "google/gemma-4-e4b") ?? chat[0];
if (!model)
  throw new Error(
    `LM Studio en ${BASE} no tiene un modelo de chat. Hay: ${models.join(", ") || "(ninguno)"}`,
  );
console.log(`Modelo: ${model}`);
const run = await askModel(model);
console.log("Herramientas:");
for (const line of run.toolsUsed) console.log(`  ${line}`);
console.log("Texto:");
for (const text of run.texts) console.log(text);
assertNoLeak([...run.toolsUsed, ...run.texts]);
if (run.toolsUsed.length === 0) {
  console.log(
    "El modelo no llamó herramientas. El cierre directo sí se cumplió, y ningún texto contiene el secreto.",
  );
} else {
  for (const line of run.toolsUsed) {
    if (line.startsWith("read_note") && line.includes("doc-foreign"))
      assert.match(line, /No lo encontré/);
    if (line.startsWith("read_note") && line.includes("doc-hidden"))
      assert.match(line, /No lo encontré/);
    if (line.startsWith("update_note") && (line.includes("doc-ro") || line.includes("doc-ws-read")))
      assert.match(line, /no editarlo/);
  }
  console.log("El modelo usó herramientas y el permiso se respetó.");
}
