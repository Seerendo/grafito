import { PERMISSION } from "@/domain/permissions";
import { namedCells, text } from "./args.ts";
import type { Tool } from "./tool.ts";

/** Table tools read rows and add/update cells when the document is editable. */
export const tableTools: Tool[] = [
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
      if (!cells) {
        return {
          result: {
            error: 'cells tiene que ser un objeto JSON, por ejemplo {"Estado":"pendiente"}.',
          },
          event: { label: "La fila no se pudo leer", ok: false },
        };
      }
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
