import type { Sql } from "@/lib/db";
import { PERMISSION } from "@/domain/permissions";
import type { UserProfile } from "@/server/profile";
import { VaultError } from "@/server/vault";
import { openCorpus, type ToolResult } from "./corpus.ts";
import type { VaultCaps } from "./access.ts";
import type { ToolCall, ToolSpec } from "./types.ts";

/**
 * Herramientas del asistente. Cuáles se ofrecen lo decide el rol (y el perfil
 * de solo lectura). Qué documento alcanza cada llamada lo decide `corpus.ts`:
 * solo lo que esta persona puede abrir, y escribir solo donde puede editar.
 */

export type ToolEvent = ToolResult["event"];

type Tool = {
  spec: ToolSpec;
  permission: string;
  /** Crea o cambia algo: fuera en un perfil de solo lectura. */
  writes?: boolean;
  run: (
    corpus: ReturnType<typeof openCorpus>,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
};

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : String(value);
}

/** `cells` llega como JSON en texto (el esquema de herramientas no admite objetos). */
function namedCells(args: Record<string, unknown>): Record<string, unknown> | null {
  const raw = args.cells;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    return null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

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
  specs: ToolSpec[];
  run: (call: ToolCall) => Promise<{ content: string; event: ToolEvent }>;
} {
  const readOnly = options.readOnly ?? false;
  const corpus = openCorpus(sql, userId, capsFor(profile, readOnly), `${profile.displayName} (IA)`);
  const tools: Tool[] = [
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "list_portfolios",
        description:
          "Lista los portafolios que esta persona puede abrir: los suyos, los compartidos y los de espacios de trabajo. Cada uno dice si el acceso es de lectura o de edición.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      run: (vault) => vault.listPortfolios(),
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "list_notes",
        description:
          "Lista notas y archivos que esta persona puede abrir, sin su contenido. Filtra por portafolio (id, nombre, ruta o 'root' para la Carpeta Personal) y/o por texto. Cada uno dice el sitio y si se puede editar.",
        parameters: {
          type: "object",
          properties: {
            portfolio_id: {
              type: "string",
              description:
                "Id, nombre o ruta del portafolio; 'root' para la Carpeta Personal; vacío para todos",
            },
            query: { type: "string", description: "Texto a buscar en el título o el contenido" },
          },
          required: [],
        },
      },
      run: (vault, args) =>
        vault.listNotes({ portfolio: text(args, "portfolio_id"), query: text(args, "query") }),
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "search_notes",
        description:
          "Busca entre lo que esta persona puede abrir: título o contenido. No devuelve documentos ajenos ni carpetas de un espacio que no le concedieron.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Texto a buscar" } },
          required: ["query"],
        },
      },
      run: (vault, args) => vault.searchNotes(text(args, "query")),
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "read_note",
        description:
          "Lee una nota o un archivo que esta persona puede abrir, por id o por título. Si hay varios con el mismo título, pide el id. Devuelve el texto de las notas y de los archivos de texto, Office, OpenDocument y PDF con texto.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id de la nota o archivo, o su título" },
          },
          required: ["id"],
        },
      },
      run: (vault, args) => vault.readNote(text(args, "id")),
    },
    {
      permission: PERMISSION.notesCreate,
      writes: true,
      spec: {
        name: "create_note",
        description:
          "Crea una nota Markdown donde esta persona puede editar (su bóveda, un compartido con edición, o una carpeta de espacio concedida en edición). Si el acceso es de lectura, no la crea. Usa [[Título]] para enlazar.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Título (si existe, se le añade un número)" },
            content: { type: "string", description: "Contenido en Markdown" },
            portfolio_id: {
              type: "string",
              description: "Id, nombre o ruta del portafolio; vacío para la Carpeta Personal",
            },
          },
          required: ["title", "content"],
        },
      },
      run: (vault, args) =>
        vault.createNote({
          title: text(args, "title"),
          content: text(args, "content"),
          portfolio: text(args, "portfolio_id") || text(args, "portfolio"),
        }),
    },
    {
      permission: PERMISSION.notesEdit,
      writes: true,
      spec: {
        name: "update_note",
        description:
          "Cambia una nota que esta persona puede editar: reemplaza el contenido, añade texto al final (append) o la renombra. Si solo puede verla, la herramienta lo rechaza y no cambia nada.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id de la nota, o su título" },
            content: {
              type: "string",
              description: "Contenido nuevo completo, o el texto a añadir si append es true",
            },
            append: {
              type: "boolean",
              description: "true para añadir el contenido al final en vez de reemplazar",
            },
            title: { type: "string", description: "Título nuevo (opcional)" },
          },
          required: ["id"],
        },
      },
      run: (vault, args) =>
        vault.updateNote({
          ref: text(args, "id"),
          content: args.content === undefined ? undefined : text(args, "content"),
          append: args.append === true || args.append === "true",
          title: text(args, "title") || undefined,
        }),
    },
    {
      permission: PERMISSION.portfoliosManage,
      writes: true,
      spec: {
        name: "create_portfolio",
        description:
          "Crea un portafolio donde esta persona puede editar, opcionalmente dentro de otro. No lo crea en un sitio de solo lectura.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nombre" },
            parent_id: {
              type: "string",
              description: "Id, nombre o ruta del portafolio padre; vacío para la Carpeta Personal",
            },
          },
          required: ["name"],
        },
      },
      run: (vault, args) =>
        vault.createPortfolio({ name: text(args, "name"), parent: text(args, "parent_id") }),
    },
    {
      permission: PERMISSION.notesRead,
      spec: {
        name: "query_table",
        description:
          "Lee filas de una tabla (.tabla) que esta persona puede abrir. Filtra por texto opcional. Devuelve como mucho 40 filas, con las columnas por su nombre. Las fórmulas llegan ya calculadas.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Id o título de la tabla" },
            query: {
              type: "string",
              description: "Texto que debe aparecer en la fila; vacío para las primeras",
            },
            limit: { type: "number", description: "Máximo de filas (1 a 40)" },
          },
          required: ["table"],
        },
      },
      run: (vault, args) =>
        vault.queryTable({
          ref: text(args, "table"),
          query: text(args, "query"),
          limit: Number(args.limit) || undefined,
        }),
    },
    {
      permission: PERMISSION.notesEdit,
      writes: true,
      spec: {
        name: "add_table_row",
        description:
          "Añade una fila a una tabla que esta persona puede editar. cells es un objeto JSON en texto: las claves son los nombres de las columnas. Si la tabla es de solo lectura, no añade nada.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Id o título de la tabla" },
            cells: {
              type: "string",
              description:
                'Objeto JSON en texto. Las claves son los nombres de las columnas. Ejemplo: {"Estado":"pendiente","Importe":12}',
            },
          },
          required: ["table", "cells"],
        },
      },
      run: async (vault, args) => {
        const cells = namedCells(args);
        if (!cells)
          return {
            result: {
              error: 'cells tiene que ser un objeto JSON, por ejemplo {"Estado":"pendiente"}.',
            },
            event: { label: "La fila no se pudo leer", ok: false },
          };
        return vault.addTableRow({ ref: text(args, "table"), cells });
      },
    },
    {
      permission: PERMISSION.notesEdit,
      writes: true,
      spec: {
        name: "set_table_cell",
        description:
          "Cambia una celda de una tabla que esta persona puede editar. La fila se indica por su id (el de query_table) y la columna por su nombre. Si solo puede ver la tabla, no cambia nada.",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Id o título de la tabla" },
            row_id: { type: "string", description: "Id de la fila" },
            column: { type: "string", description: "Nombre de la columna" },
            value: {
              type: "string",
              description:
                "Valor nuevo como texto (número, fecha AAAA-MM-DD, sí/no). Vacío para borrar la celda.",
            },
          },
          required: ["table", "row_id", "column"],
        },
      },
      run: (vault, args) =>
        vault.setTableCell({
          ref: text(args, "table"),
          rowId: text(args, "row_id"),
          column: text(args, "column"),
          value: args.value ?? null,
        }),
    },
  ];

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
