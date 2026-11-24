import { PERMISSION } from "@/domain/permissions";
import { text } from "./args.ts";
import type { Tool } from "./tool.ts";

/**
 * Graph tools: read-only walks over the links between documents, from Grafeno, limited to what
 * this person can open. They need the Grafo plugin and Grafeno answering; otherwise they say so.
 */
export const graphTools: Tool[] = [
  {
    permission: PERMISSION.graphView,
    spec: {
      name: "graph_overview",
      description:
        "Panorama de cómo se relacionan los documentos: comunidades (grupos de notas muy enlazadas entre sí, con sus notas principales), notas puente que unen grupos y notas huérfanas sin vínculos. Úsala para preguntas generales como «de qué temas hablan mis notas» o «qué notas están sueltas». Sin document mira la Carpeta Personal; con document, el compartido o espacio de trabajo donde está ese documento.",
      parameters: {
        type: "object",
        properties: {
          document: {
            type: "string",
            description:
              "Id o título de un documento del compartido o espacio a analizar; vacío para la Carpeta Personal",
          },
        },
        required: [],
      },
    },
    run: (vault, args) => vault.graphOverview(text(args, "document")),
  },
  {
    permission: PERMISSION.graphView,
    spec: {
      name: "graph_neighbors",
      description:
        "Documentos alrededor de uno, a 1, 2 o 3 vínculos de distancia en cualquier dirección. Para los directos dice si este documento los enlaza o ellos lo enlazan, y cómo ([[enlace]], referencia o invoca). Úsala para «qué se relaciona con X» o «qué hay cerca de X».",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id o título del documento" },
          depth: {
            type: "string",
            description: "Distancia máxima, de 1 a 3; vacío para 1",
          },
        },
        required: ["id"],
      },
    },
    run: (vault, args) => vault.graphNeighbors(text(args, "id"), Number(text(args, "depth")) || 1),
  },
  {
    permission: PERMISSION.graphView,
    spec: {
      name: "graph_path",
      description:
        "La cadena de vínculos más corta entre dos documentos, en cualquier dirección, con cómo se enlaza cada paso. Úsala para «cómo se relaciona X con Y». Si no hay camino, lo dice.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Id o título del primer documento" },
          to: { type: "string", description: "Id o título del segundo documento" },
        },
        required: ["from", "to"],
      },
    },
    run: (vault, args) => vault.graphPath(text(args, "from"), text(args, "to")),
  },
  {
    permission: PERMISSION.graphView,
    spec: {
      name: "graph_related",
      description:
        "Documentos que convendría enlazar con uno: comparten vecinos con él y todavía no están enlazados. Úsala para sugerir vínculos o «qué más debería leer junto a X». Solo sugiere: para enlazar de verdad hace falta otra herramienta o la persona.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id o título del documento" },
        },
        required: ["id"],
      },
    },
    run: (vault, args) => vault.graphRelated(text(args, "id")),
  },
];
