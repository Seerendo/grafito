import { PERMISSION } from "@/domain/permissions";
import { text } from "./args.ts";
import type { Tool } from "./tool.ts";

/** Note, file and portfolio tools; search uses the content index. */
export const noteTools: Tool[] = [
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
        "Lista notas y archivos que esta persona puede abrir, sin su contenido. Filtra por portafolio (id, nombre, ruta o 'root' para la Carpeta Personal) y/o por texto del título o del índice. Cada uno dice el sitio y si se puede editar.",
      parameters: {
        type: "object",
        properties: {
          portfolio_id: {
            type: "string",
            description:
              "Id, nombre o ruta del portafolio; 'root' para la Carpeta Personal; vacío para todos",
          },
          query: {
            type: "string",
            description: "Texto a buscar en el título o en el contenido indexado",
          },
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
        "Busca la frase exacta en notas, tablas y archivos (PDF, Word .docx, Excel, PowerPoint y OpenDocument) que esta persona puede abrir. Solo devuelve un documento si la frase está entera, y un fragmento por cada vez que aparece. No devuelve documentos ajenos ni carpetas de un espacio que no le concedieron. El .doc antiguo no tiene texto indexado.",
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
];
