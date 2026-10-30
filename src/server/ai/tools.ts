import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import type { Portfolio } from "@/domain/vault/types";
import type { UserProfile } from "@/server/profile";
import { isTableName } from "@/domain/vault/table";
import { fileText } from "@/server/files";
import { addNamedRow, queryRows, readFields, updateCell } from "@/server/table";
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
  /** Crea o cambia algo: fuera en un perfil de solo lectura. */
  writes?: boolean;
  run: (args: Record<string, unknown>) => Promise<{ result: unknown; event: ToolEvent }>;
};

const MAX_NOTE = 30_000;

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/** `cells` llega como JSON en texto (el esquema de herramientas no admite objetos). */
function namedCells(args: Record<string, unknown>): Record<string, unknown> | null {
  const raw = args.cells;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    return null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function path(portfolios: Portfolio[], id: string | null): string {
  if (!id) return "Carpeta Personal";
  const names: string[] = [];
  let current = portfolios.find((portfolio) => portfolio.id === id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? portfolios.find((portfolio) => portfolio.id === current!.parentId) : undefined;
  }
  return names.join(" › ") || "Carpeta Personal";
}

function clean(ref: string): string {
  return ref.trim().replace(/^\[\[|\]\]$/g, "").replace(/^[«"']|[»"']$/g, "").trim();
}

/**
 * Un documento por su id, su título exacto o, si solo uno lo contiene, parte
 * de su título (sin distinguir mayúsculas). Los modelos suelen dar el título
 * en vez del id, o un título aproximado.
 */
async function findDoc(sql: Sql, userId: string, ref: string) {
  const key = clean(ref);
  if (!key) return null;
  const byId = await getDoc(sql, userId, key);
  if (byId) return byId;
  const lower = key.toLowerCase();
  const candidates = await listDocs(sql, userId, { query: key, limit: 50 });
  const exact = candidates.find((doc) => doc.title.toLowerCase() === lower);
  if (exact) return getDoc(sql, userId, exact.id);
  const partial = candidates.filter((doc) => doc.title.toLowerCase().includes(lower));
  return partial.length === 1 ? getDoc(sql, userId, partial[0]!.id) : null;
}

/** Documentos cuyo título se parece a `ref`, para ayudar al modelo a elegir. */
async function similarDocs(sql: Sql, userId: string, ref: string) {
  const key = clean(ref);
  const docs = key ? await listDocs(sql, userId, { query: key, limit: 8 }) : [];
  return docs.map((doc) => ({ id: doc.id, title: doc.title }));
}

/**
 * Un portafolio por su id, su nombre o su ruta («Proyectos › Atlas»), sin
 * distinguir mayúsculas. `undefined` si no se pidió ninguno; `null` para la
 * Carpeta Personal; `false` si no existe.
 */
function resolvePortfolio(portfolios: Portfolio[], ref: string): string | null | false | undefined {
  const key = clean(ref);
  if (!key) return undefined;
  const lower = key.toLowerCase();
  if (["root", "null", "raíz", "raiz", "carpeta personal", "personal"].includes(lower)) return null;
  const byId = portfolios.find((portfolio) => portfolio.id === key);
  if (byId) return byId.id;
  const byPath = portfolios.find((portfolio) => path(portfolios, portfolio.id).toLowerCase() === lower.replace(/\s*[›>/]\s*/g, " › "));
  if (byPath) return byPath.id;
  const byName = portfolios.filter((portfolio) => portfolio.name.toLowerCase() === lower);
  return byName.length === 1 ? byName[0]!.id : false;
}

function portfolioChoices(portfolios: Portfolio[]) {
  return portfolios.map((portfolio) => ({ id: portfolio.id, name: portfolio.name, path: path(portfolios, portfolio.id) }));
}

export function vaultTools(sql: Sql, userId: string, profile: UserProfile, options: { readOnly?: boolean } = {}): {
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
          "Lista notas y archivos (sin su contenido). Filtra por portafolio (su id, su nombre o 'root' para la Carpeta Personal) y/o por texto.",
        parameters: {
          type: "object",
          properties: {
            portfolio_id: { type: "string", description: "Id o nombre del portafolio, 'root' para la Carpeta Personal; vacío para todos" },
            query: { type: "string", description: "Texto a buscar en el título o el contenido" },
          },
          required: [],
        },
      },
      run: async (args) => {
        const portfolios = await listPortfolios(sql, userId);
        const portfolioId = resolvePortfolio(portfolios, text(args, "portfolio_id"));
        if (portfolioId === false) {
          return {
            result: { error: "Ese portafolio no existe. Estos son los que hay:", portfolios: portfolioChoices(portfolios) },
            event: { label: "No encontró el portafolio", ok: false },
          };
        }
        const docs = await listDocs(sql, userId, {
          portfolioId,
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
          "Lee una nota (Markdown) o un archivo por su id o su título. Devuelve el texto de las notas, de los archivos de texto, de Word, Excel, PowerPoint, OpenDocument y de los PDF con texto; de los demás, sus datos.",
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
            result: {
              error: "No lo encontré. Usa el id de uno de estos, o list_notes / search_notes:",
              similar: await similarDocs(sql, userId, text(args, "id")),
            },
            event: { label: "No encontró el documento", ok: false },
          };
        }
        const portfolios = await listPortfolios(sql, userId);
        const body =
          doc.kind === "markdown"
            ? doc.content.length > MAX_NOTE
              ? `${doc.content.slice(0, MAX_NOTE)}\n…(recortado)`
              : doc.content
            : ((await fileText(sql, doc)) ?? `(archivo ${doc.file?.mime ?? ""} sin texto legible: una imagen, un PDF escaneado o un formato no soportado)`);
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
      writes: true,
      spec: {
        name: "create_note",
        description: "Crea una nota Markdown nueva. Usa [[Título]] para enlazar otras notas.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Título (si existe, se le añade un número)" },
            content: { type: "string", description: "Contenido en Markdown" },
            portfolio_id: {
              type: "string",
              description: "Id o nombre del portafolio donde crearla (también uno que acabas de crear); vacío para la Carpeta Personal",
            },
          },
          required: ["title", "content"],
        },
      },
      run: async (args) => {
        const portfolios = await listPortfolios(sql, userId);
        const portfolioId = resolvePortfolio(portfolios, text(args, "portfolio_id") || text(args, "portfolio"));
        if (portfolioId === false) {
          return {
            result: {
              error: "Ese portafolio no existe. Usa el id de uno de estos, o créalo antes con create_portfolio:",
              portfolios: portfolioChoices(portfolios),
            },
            event: { label: "No encontró el portafolio", ok: false },
          };
        }
        const doc = await createNote(sql, userId, {
          title: text(args, "title"),
          content: text(args, "content"),
          portfolioId: portfolioId ?? null,
          actor,
        });
        return {
          result: { id: doc.id, title: doc.title, portfolio: path(portfolios, doc.portfolioId) },
          event: { label: `Creó «${doc.title}»`, ok: true, docId: doc.id, changed: true },
        };
      },
    },
    {
      permission: PERMISSION.notesEdit,
      writes: true,
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
            result: {
              error: "No la encontré. Usa el id de una de estas, o list_notes / search_notes:",
              similar: await similarDocs(sql, userId, text(args, "id")),
            },
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
      writes: true,
      spec: {
        name: "create_portfolio",
        description: "Crea un portafolio (carpeta), opcionalmente dentro de otro.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nombre" },
            parent_id: { type: "string", description: "Id o nombre del portafolio padre; vacío para la Carpeta Personal" },
          },
          required: ["name"],
        },
      },
      run: async (args) => {
        const portfolios = await listPortfolios(sql, userId);
        const parentId = resolvePortfolio(portfolios, text(args, "parent_id"));
        if (parentId === false) {
          return {
            result: { error: "Ese portafolio padre no existe. Estos son los que hay:", portfolios: portfolioChoices(portfolios) },
            event: { label: "No encontró el portafolio padre", ok: false },
          };
        }
        const portfolio = await createPortfolio(sql, userId, { name: text(args, "name"), parentId: parentId ?? null });
        return {
          result: { ...portfolio, note: "Para crear notas dentro, usa este id en portfolio_id." },
          event: { label: `Creó el portafolio «${portfolio.name}»`, ok: true, changed: true },
        };
      },
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "query_table",
        description:
          "Lee filas de una tabla de datos de la bóveda (un archivo .tabla). Filtra por texto opcional. Devuelve como mucho 40 filas, con las columnas por su nombre. Las fórmulas llegan ya calculadas.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Id o título de la tabla" },
            query: { type: "string", description: "Texto que debe aparecer en la fila; vacío para las primeras" },
            limit: { type: "number", description: "Máximo de filas (1 a 40)" },
          },
          required: ["table"],
        },
      },
      run: async (args) => {
        const doc = await findDoc(sql, userId, text(args, "table"));
        if (!doc?.file || !isTableName(doc.file.name)) {
          return {
            result: { error: "No encontré esa tabla. Usa el id o el título exacto.", similar: await similarDocs(sql, userId, text(args, "table")) },
            event: { label: "No encontró la tabla", ok: false },
          };
        }
        const limit = Math.min(40, Math.max(1, Number(args.limit) || 20));
        const found = await queryRows(sql, userId, doc.id, text(args, "query"), limit);
        return {
          result: { id: doc.id, title: doc.title, ...(found ?? { fields: [], rows: [] }) },
          event: { label: `Consultó «${doc.title}»`, ok: true, docId: doc.id },
        };
      },
    },
    {
      permission: PERMISSION.notesEdit,
      writes: true,
      spec: {
        name: "add_table_row",
        description: "Añade una fila a una tabla de datos. cells es un objeto JSON en texto: las claves son los nombres de las columnas.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Id o título de la tabla" },
            cells: {
              type: "string",
              description: "Objeto JSON en texto. Las claves son los nombres de las columnas. Ejemplo: {\"Estado\":\"pendiente\",\"Importe\":12}",
            },
          },
          required: ["table", "cells"],
        },
      },
      run: async (args) => {
        const doc = await findDoc(sql, userId, text(args, "table"));
        if (!doc?.file || !isTableName(doc.file.name)) {
          return { result: { error: "No encontré esa tabla." }, event: { label: "No encontró la tabla", ok: false } };
        }
        const named = namedCells(args);
        if (!named) return { result: { error: "cells tiene que ser un objeto JSON, por ejemplo {\"Estado\":\"pendiente\"}." }, event: { label: "La fila no se pudo leer", ok: false } };
        const created = await addNamedRow(sql, userId, doc.id, named, actor);
        if (!created.ok) return { result: created, event: { label: created.error, ok: false } };
        return {
          result: { id: doc.id, title: doc.title, rowId: created.row.id },
          event: { label: `Añadió una fila a «${doc.title}»`, ok: true, docId: doc.id, changed: true },
        };
      },
    },
    {
      permission: PERMISSION.notesEdit,
      writes: true,
      spec: {
        name: "set_table_cell",
        description: "Cambia una celda. Identifica la fila por su id (el que devuelve query_table) y la columna por su nombre.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Id o título de la tabla" },
            row_id: { type: "string", description: "Id de la fila" },
            column: { type: "string", description: "Nombre de la columna" },
            value: { type: "string", description: "Valor nuevo como texto (número, fecha AAAA-MM-DD, sí/no). Vacío para borrar la celda." },
          },
          required: ["table", "row_id", "column"],
        },
      },
      run: async (args) => {
        const doc = await findDoc(sql, userId, text(args, "table"));
        if (!doc?.file || !isTableName(doc.file.name)) {
          return { result: { error: "No encontré esa tabla." }, event: { label: "No encontró la tabla", ok: false } };
        }
        const fields = await readFields(sql, userId, doc.id);
        const column = text(args, "column").trim().toLowerCase();
        const field = fields.find((item) => item.name.trim().toLowerCase() === column || item.id === text(args, "column"));
        if (!field) return { result: { error: "Esa columna no existe.", columns: fields.map((item) => item.name) }, event: { label: "No encontró la columna", ok: false } };
        const saved = await updateCell(sql, userId, doc.id, { rowId: text(args, "row_id"), fieldId: field.id, value: args.value ?? null }, actor);
        if (!saved.ok) return { result: saved, event: { label: saved.error, ok: false } };
        return {
          result: { id: doc.id, title: doc.title, rowId: saved.row.id },
          event: { label: `Editó «${doc.title}»`, ok: true, docId: doc.id, changed: true },
        };
      },
    },
  ];

  const allowed = tools.filter(
    (tool) => (profile.isAdmin || profile.permissions.includes(tool.permission)) && !(options.readOnly && tool.writes),
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
        const { result, event } = await tool.run(call.arguments);
        return { content: JSON.stringify(result), event };
      } catch (error) {
        const message = error instanceof VaultError ? error.message : "Error al ejecutar la herramienta.";
        return { content: JSON.stringify({ error: message }), event: { label: message, ok: false } };
      }
    },
  };
}
