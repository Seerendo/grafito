import { PERMISSION } from "@/domain/permissions";
import { text } from "./args.ts";
import { linkKind } from "./notes.ts";
import type { Tool } from "./tool.ts";

/** Moving and renaming, the trash, versions, comments and links between documents. */
export const organizeTools: Tool[] = [
  {
    permission: PERMISSION.notesEdit,
    writes: true,
    spec: {
      name: "move_document",
      description:
        "Mueve una nota, un archivo o una tabla a otro portafolio del mismo espacio: dentro de la Carpeta Personal, o dentro del mismo compartido si se puede editar. Para renombrar una nota usa update_note con title.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id o título del documento" },
          portfolio_id: {
            type: "string",
            description:
              "Id, nombre o ruta del portafolio de destino; 'root' para la Carpeta Personal",
          },
        },
        required: ["id", "portfolio_id"],
      },
    },
    run: (vault, args) =>
      vault.moveDocument({ ref: text(args, "id"), portfolio: text(args, "portfolio_id") }),
  },
  {
    permission: PERMISSION.portfoliosManage,
    writes: true,
    spec: {
      name: "update_portfolio",
      description:
        "Renombra un portafolio de la Carpeta Personal o lo mueve dentro de otro. Lo que contiene va con él. No cambia portafolios compartidos por otra persona.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id, nombre o ruta del portafolio" },
          name: { type: "string", description: "Nombre nuevo; vacío para dejarlo" },
          parent_id: {
            type: "string",
            description:
              "Id, nombre o ruta del portafolio donde ponerlo; 'root' para la raíz; sin indicar para dejarlo donde está",
          },
        },
        required: ["id"],
      },
    },
    run: (vault, args) =>
      vault.changePortfolio({
        ref: text(args, "id"),
        name: text(args, "name"),
        parent:
          args.parent_id === undefined || args.parent_id === null
            ? undefined
            : text(args, "parent_id"),
      }),
  },
  {
    permission: PERMISSION.notesRead,
    spec: {
      name: "list_trash",
      description:
        "Lista lo que hay en la papelera de esta persona: notas, archivos y portafolios eliminados, con la fecha.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: (vault) => vault.listTrashItems(),
  },
  {
    permission: PERMISSION.notesEdit,
    writes: true,
    spec: {
      name: "restore_from_trash",
      description:
        "Saca de la papelera una nota, un archivo o un portafolio (con lo que contenía) y lo devuelve a su sitio.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Id del elemento (el de list_trash)" } },
        required: ["id"],
      },
    },
    run: (vault, args) => vault.restoreItem(text(args, "id")),
  },
  {
    permission: PERMISSION.notesRead,
    spec: {
      name: "list_versions",
      description:
        "Lista las versiones guardadas de una nota o un archivo, de la más reciente a la más antigua, con autor y fecha.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Id o título del documento" } },
        required: ["id"],
      },
    },
    run: (vault, args) => vault.documentVersions(text(args, "id")),
  },
  {
    permission: PERMISSION.notesRead,
    spec: {
      name: "read_version",
      description:
        "Lee el texto de una versión anterior de una nota. Si es larga, sigue con offset = next_offset.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id o título del documento" },
          version_id: { type: "string", description: "Id de la versión (el de list_versions)" },
          offset: { type: "number", description: "Desde qué carácter leer; 0 al principio" },
        },
        required: ["id", "version_id"],
      },
    },
    run: (vault, args) =>
      vault.documentVersion(text(args, "id"), text(args, "version_id"), Number(args.offset) || 0),
  },
  {
    permission: PERMISSION.notesRead,
    spec: {
      name: "list_comments",
      description:
        "Lee los comentarios de una nota o un archivo que esta persona puede abrir, con autor y fecha.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Id o título del documento" } },
        required: ["id"],
      },
    },
    run: (vault, args) => vault.documentComments(text(args, "id")),
  },
  {
    permission: PERMISSION.notesRead,
    writes: true,
    spec: {
      name: "add_comment",
      description:
        "Añade un comentario a una nota o un archivo que esta persona puede abrir, aunque solo pueda leerlo. Firma con su nombre.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id o título del documento" },
          body: { type: "string", description: "Texto del comentario" },
        },
        required: ["id", "body"],
      },
    },
    run: (vault, args) => vault.commentDocument(text(args, "id"), text(args, "body")),
  },
  {
    permission: PERMISSION.linksManage,
    writes: true,
    spec: {
      name: "link_documents",
      description:
        "Vincula un documento con otro, como el vínculo manual de la aplicación: aparece en el grafo y en «Relacionadas». El origen tiene que poder editarse. Para una frase de un PDF usa link_pdf_phrase.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Id o título del documento de origen" },
          to: { type: "string", description: "Id o título del documento destino" },
          kind: { type: "string", description: "referencia (por defecto) o llama" },
        },
        required: ["from", "to"],
      },
    },
    run: (vault, args) => {
      const kind = linkKind(text(args, "kind"));
      if (!kind)
        return Promise.resolve({
          result: { error: "kind es referencia o llama." },
          event: { label: "No vinculó", ok: false },
        });
      return vault.linkDocuments({ from: text(args, "from"), to: text(args, "to"), kind });
    },
  },
];
