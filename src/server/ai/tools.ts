import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import type { Portfolio } from "@/domain/vault/types";
import type { UserProfile } from "@/server/profile";
import { fileText } from "@/server/files";
import { createNote, createPortfolio, getDoc, listDocs, listPortfolios, updateNote, VaultError } from "@/server/vault";
import type { ToolCall, ToolSpec } from "./types.ts";

/**
 * Herramientas que la IA puede usar sobre la bóveda del usuario. Solo se le
 * ofrecen las que su rol permite, y todas pasan por `server/vault.ts` (lo mismo
 * que usa la API REST).
 */

export type ToolEvent = {
  /** Frase corta para mostrar en el chat: «Leyó «Bienvenida»». */
  label: string;
  ok: boolean;
  docId?: string;
  /** La bóveda cambió (el navegador debe sincronizar). */
  changed?: boolean;
};

type Tool = {
  spec: ToolSpec;
  permission: string;
  run: (args: Record<string, unknown>) => Promise<{ result: unknown; event: ToolEvent }>;
};

const MAX_NOTE = 30_000;

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function optionalId(args: Record<string, unknown>, key: string): string | null {
  const value = text(args, key).trim();
  return value && value !== "null" && value !== "root" ? value : null;
}

function path(portfolios: Portfolio[], id: string | null): string {
  if (!id) return "Raíz";
  const names: string[] = [];
  let current = portfolios.find((portfolio) => portfolio.id === id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? portfolios.find((portfolio) => portfolio.id === current!.parentId) : undefined;
  }
  return names.join(" › ") || "Raíz";
}

/** Un documento por su id o, si no, por su título exacto (sin distinguir mayúsculas). */
async function findDoc(sql: Sql, userId: string, ref: string) {
  const key = ref.trim().replace(/^\[\[|\]\]$/g, "").replace(/^«|»$/g, "");
  if (!key) return null;
  const byId = await getDoc(sql, userId, key);
  if (byId) return byId;
  const candidates = await listDocs(sql, userId, { query: key, limit: 20 });
  const match = candidates.find((doc) => doc.title.toLowerCase() === key.toLowerCase());
  return match ? getDoc(sql, userId, match.id) : null;
}

export function vaultTools(sql: Sql, userId: string, profile: UserProfile): {
  specs: ToolSpec[];
  run: (call: ToolCall) => Promise<{ content: string; event: ToolEvent }>;
} {
  const actor = `${profile.displayName} (IA)`;
  const tools: Tool[] = [
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "list_portfolios",
        description: "Lista los portafolios (carpetas) del usuario con su id, nombre y portafolio padre.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      run: async () => {
        const portfolios = await listPortfolios(sql, userId);
        return {
          result: portfolios.map((portfolio) => ({ ...portfolio, path: path(portfolios, portfolio.id) })),
          event: { label: `Revisó ${portfolios.length} portafolios`, ok: true },
        };
      },
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "list_notes",
        description:
          "Lista notas y archivos (sin su contenido). Filtra por portafolio (id, o 'root' para la raíz) y/o por texto.",
        parameters: {
          type: "object",
          properties: {
            portfolio_id: { type: "string", description: "Id del portafolio, 'root' para la raíz; vacío para todos" },
            query: { type: "string", description: "Texto a buscar en el título o el contenido" },
          },
          required: [],
        },
      },
      run: async (args) => {
        const raw = text(args, "portfolio_id").trim();
        const portfolios = await listPortfolios(sql, userId);
        const docs = await listDocs(sql, userId, {
          portfolioId: raw ? (raw === "root" ? null : raw) : undefined,
          query: text(args, "query") || undefined,
          limit: 100,
        });
        return {
          result: docs.map((doc) => ({
            id: doc.id,
            title: doc.title,
            kind: doc.kind,
            portfolio: path(portfolios, doc.portfolioId),
            portfolio_id: doc.portfolioId,
            file: doc.fileName,
            updated: new Date(doc.updatedAt).toISOString(),
          })),
          event: { label: `Listó ${docs.length} documentos`, ok: true },
        };
      },
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "search_notes",
        description: "Busca notas y archivos cuyo título o contenido contenga el texto.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Texto a buscar" } },
          required: ["query"],
        },
      },
      run: async (args) => {
        const query = text(args, "query");
        const docs = await listDocs(sql, userId, { query, limit: 30 });
        return {
          result: docs.map((doc) => ({ id: doc.id, title: doc.title, kind: doc.kind })),
          event: { label: `Buscó «${query}» (${docs.length})`, ok: true },
        };
      },
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "read_note",
        description:
          "Lee una nota (Markdown) o un archivo por su id. De los archivos de texto devuelve su contenido; de los demás, sus datos.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Id de la nota o archivo (o su título exacto)" } },
          required: ["id"],
        },
      },
      run: async (args) => {
        const doc = await findDoc(sql, userId, text(args, "id"));
        if (!doc) {
          return {
            result: { error: "No existe. Usa list_notes o search_notes para ver los ids." },
            event: { label: "No encontró el documento", ok: false },
          };
        }
        const portfolios = await listPortfolios(sql, userId);
        const body =
          doc.kind === "markdown"
            ? doc.content.length > MAX_NOTE
              ? `${doc.content.slice(0, MAX_NOTE)}\n…(recortado)`
              : doc.content
            : ((await fileText(sql, doc)) ?? `(archivo binario ${doc.file?.mime ?? ""}, no se puede leer como texto)`);
        return {
          result: {
            id: doc.id,
            title: doc.title,
            kind: doc.kind,
            portfolio: path(portfolios, doc.portfolioId),
            file: doc.file ? { name: doc.file.name, mime: doc.file.mime } : null,
            updated: new Date(doc.updatedAt).toISOString(),
            updated_by: doc.updatedBy,
            content: body,
          },
          event: { label: `Leyó «${doc.title}»`, ok: true, docId: doc.id },
        };
      },
    },
    {
      permission: PERMISSION.notesCreate,
      spec: {
        name: "create_note",
        description: "Crea una nota Markdown nueva. Usa [[Título]] para enlazar otras notas.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Título (si existe, se le añade un número)" },
            content: { type: "string", description: "Contenido en Markdown" },
            portfolio_id: { type: "string", description: "Id del portafolio; vacío para la raíz" },
          },
          required: ["title", "content"],
        },
      },
      run: async (args) => {
        const doc = await createNote(sql, userId, {
          title: text(args, "title"),
          content: text(args, "content"),
          portfolioId: optionalId(args, "portfolio_id"),
          actor,
        });
        return {
          result: { id: doc.id, title: doc.title },
          event: { label: `Creó «${doc.title}»`, ok: true, docId: doc.id, changed: true },
        };
      },
    },
    {
      permission: PERMISSION.notesEdit,
      spec: {
        name: "update_note",
        description:
          "Cambia una nota existente: reemplaza su contenido, le añade texto al final (append) o la renombra.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id de la nota (o su título exacto)" },
            content: { type: "string", description: "Contenido nuevo completo, o el texto a añadir si append es true" },
            append: { type: "boolean", description: "true para añadir el contenido al final en vez de reemplazar" },
            title: { type: "string", description: "Título nuevo (opcional)" },
          },
          required: ["id"],
        },
      },
      run: async (args) => {
        const current = await findDoc(sql, userId, text(args, "id"));
        if (!current) {
          return {
            result: { error: "No existe. Usa list_notes o search_notes para ver los ids." },
            event: { label: "No encontró la nota", ok: false },
          };
        }
        const id = current.id;
        const content = args.content === undefined ? undefined : text(args, "content");
        const next =
          content === undefined ? undefined : args.append === true || args.append === "true" ? `${current.content.trimEnd()}\n\n${content}` : content;
        const doc = await updateNote(sql, userId, id, { content: next, title: text(args, "title") || undefined, actor });
        return {
          result: { id: doc.id, title: doc.title },
          event: { label: `Editó «${doc.title}»`, ok: true, docId: doc.id, changed: true },
        };
      },
    },
    {
      permission: PERMISSION.portfoliosManage,
      spec: {
        name: "create_portfolio",
        description: "Crea un portafolio (carpeta), opcionalmente dentro de otro.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nombre" },
            parent_id: { type: "string", description: "Id del portafolio padre; vacío para la raíz" },
          },
          required: ["name"],
        },
      },
      run: async (args) => {
        const portfolio = await createPortfolio(sql, userId, { name: text(args, "name"), parentId: optionalId(args, "parent_id") });
        return {
          result: portfolio,
          event: { label: `Creó el portafolio «${portfolio.name}»`, ok: true, changed: true },
        };
      },
    },
  ];

  const allowed = tools.filter((tool) => profile.isAdmin || profile.permissions.includes(tool.permission));
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
        const { result, event } = await tool.run(call.arguments);
        return { content: JSON.stringify(result), event };
      } catch (error) {
        const message = error instanceof VaultError ? error.message : "Error al ejecutar la herramienta.";
        return { content: JSON.stringify({ error: message }), event: { label: message, ok: false } };
      }
    },
  };
}
