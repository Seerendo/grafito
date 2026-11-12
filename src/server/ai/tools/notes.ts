import { PERMISSION } from "@/domain/permissions";
import type { ManualKind } from "@/domain/vault/types";
import { text } from "./args.ts";
import type { Tool } from "./tool.ts";

/** Page argument: omitted, a page number, or rejected. */
function pageArg(value: unknown): number | undefined | "bad" {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = typeof value === "number" ? value : typeof value === "string" ? value.trim() : null;
  if (raw === null || raw === "") return raw === "" ? undefined : "bad";
  const page = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(page) || page < 1) return "bad";
  return page;
}

function linkKind(value: string): ManualKind | null {
  const kind = value.trim().toLowerCase();
  if (!kind || kind === "referencia") return "referencia";
  if (kind === "llama") return "llama";
  return null;
}

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
        "Lee un tramo de una nota o un archivo que esta persona puede abrir, por id o por título. No devuelve el archivo entero: como mucho unos miles de caracteres. Si truncated es true, vuelve a llamarla con offset = next_offset. Los archivos salen del índice cuando ya está; si no, se extrae el texto y se recorta igual. Si index_capped es true, no hay más texto guardado. Para buscar una frase usa search_notes, que solo devuelve fragmentos. Una tabla se lee con query_table.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id de la nota o archivo, o su título" },
          offset: {
            type: "string",
            description: "Desde qué carácter continuar; vacío o 0 para el principio",
          },
        },
        required: ["id"],
      },
    },
    run: (vault, args) => {
      const raw = args.offset;
      const parsed =
        raw === undefined || raw === null || raw === ""
          ? 0
          : typeof raw === "number"
            ? raw
            : Number(String(raw).trim());
      if (!Number.isInteger(parsed) || parsed < 0) {
        return Promise.resolve({
          result: { error: "offset tiene que ser un número de carácter, desde 0." },
          event: { label: "No leyó el documento", ok: false },
        });
      }
      return vault.readNote(text(args, "id"), parsed);
    },
  },
  {
    permission: PERMISSION.notesCreate,
    writes: true,
    spec: {
      name: "create_note",
      description:
        "Crea una nota Markdown donde esta persona puede editar (su bóveda, un compartido con edición, o una carpeta de espacio concedida en edición). Si el acceso es de lectura, no la crea. Usa [[Título]] para enlazar notas entre sí. Para vincular una frase de un PDF no crees una nota: usa link_pdf_phrase.",
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
    permission: PERMISSION.notesDelete,
    writes: true,
    spec: {
      name: "delete_note",
      description:
        "Manda una nota a la papelera. No la llames en el mismo turno en que la persona pidió borrarla: primero dile el título y el sitio y espera a que confirme en su siguiente mensaje. Si hay varios títulos, pide el id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id de la nota, o su título" },
        },
        required: ["id"],
      },
    },
    run: (vault, args, context) =>
      vault.deleteDocument(text(args, "id"), "markdown", context.deleteQuestion ?? ""),
  },
  {
    permission: PERMISSION.filesDelete,
    writes: true,
    spec: {
      name: "delete_file",
      description:
        "Manda un archivo o una tabla a la papelera. No la llames hasta que la persona confirme en su siguiente mensaje, después de decirle el título y el sitio. Si hay varios títulos, pide el id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id del archivo o de la tabla, o su título" },
        },
        required: ["id"],
      },
    },
    run: (vault, args, context) =>
      vault.deleteDocument(text(args, "id"), "file", context.deleteQuestion ?? ""),
  },
  {
    permission: PERMISSION.portfoliosManage,
    writes: true,
    spec: {
      name: "delete_portfolio",
      description:
        "Manda un portafolio a la papelera, con los portafolios y documentos que contiene. No borra la Carpeta Personal ni la raíz de un compartido. No la llames hasta que la persona confirme en su siguiente mensaje. Dile antes el nombre, el sitio y que también se irá lo de dentro.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id, nombre o ruta del portafolio" },
        },
        required: ["id"],
      },
    },
    run: (vault, args, context) =>
      vault.deletePortfolio(text(args, "id"), context.deleteQuestion ?? ""),
  },
  {
    permission: PERMISSION.linksManage,
    writes: true,
    spec: {
      name: "link_pdf_phrase",
      description:
        "Vincula una frase o palabra de un PDF con otro documento. El vínculo queda en el PDF, en esa frase, igual que al seleccionarla a mano. No crea una nota. Si la frase está en varias páginas, indica page. Solo PDF con texto.",
      parameters: {
        type: "object",
        properties: {
          pdf: { type: "string", description: "Id o título del PDF de origen" },
          phrase: { type: "string", description: "Frase o palabra tal como está en el PDF" },
          target: { type: "string", description: "Id o título del documento destino" },
          page: {
            type: "string",
            description:
              "Número de página si la frase aparece en más de una; vacío cuando basta la única",
          },
          kind: {
            type: "string",
            description: "referencia (por defecto) o llama",
          },
        },
        required: ["pdf", "phrase", "target"],
      },
    },
    run: (vault, args) => {
      const kind = linkKind(text(args, "kind"));
      if (!kind) {
        return Promise.resolve({
          result: { error: "kind es referencia o llama." },
          event: { label: "No vinculó", ok: false },
        });
      }
      const page = pageArg(args.page);
      if (page === "bad") {
        return Promise.resolve({
          result: { error: "page tiene que ser un número de página." },
          event: { label: "No vinculó", ok: false },
        });
      }
      return vault.linkPdfPhrase({
        pdf: text(args, "pdf"),
        phrase: text(args, "phrase"),
        target: text(args, "target"),
        page,
        kind,
      });
    },
  },
];
