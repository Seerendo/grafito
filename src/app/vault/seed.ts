import type { Document, ManualLink, Portfolio, ViewMode } from "@/domain/vault/types";
import { SAMPLE_ROOT_ID, SAMPLE_ROOT_NAME } from "@/domain/vault/migrate";

const stamp = (day: number) => Date.UTC(2026, 2, day, 9, 0, 0);

const planoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 280">
  <rect width="480" height="280" fill="#1b1915"/>
  <rect x="20" y="20" width="440" height="240" fill="none" stroke="#e0a14a" stroke-width="3"/>
  <rect x="40" y="44" width="190" height="130" fill="#26231d" stroke="#f3eee6"/>
  <text x="135" y="114" fill="#f3eee6" font-family="sans-serif" font-size="18" text-anchor="middle">Obrador</text>
  <rect x="260" y="44" width="170" height="78" fill="#26231d" stroke="#f3eee6"/>
  <text x="345" y="90" fill="#f3eee6" font-family="sans-serif" font-size="18" text-anchor="middle">Pizarra</text>
  <text x="240" y="230" fill="#e0a14a" font-family="sans-serif" font-size="16" text-anchor="middle">Puerta</text>
</svg>`;

function md(
  id: string,
  title: string,
  portfolioId: string,
  content: string,
  day: number,
  pinned = false,
  links: ManualLink[] = [],
): Document {
  return {
    id,
    title,
    portfolioId,
    kind: "markdown",
    content: content.trim() + "\n",
    file: null,
    links,
    createdAt: stamp(day),
    updatedAt: stamp(day + 1),
    createdBy: "Administrador",
    updatedBy: "Administrador",
    pinned,
  };
}

export function createSeed(): {
  documents: Document[];
  portfolios: Portfolio[];
  activeId: string;
  mode: ViewMode;
} {
  const portfolios: Portfolio[] = [
    // Las notas de ejemplo cuelgan de un único portafolio raíz, para que la
    // bóveda de cada persona empiece ordenada y su propio trabajo quede aparte.
    { id: SAMPLE_ROOT_ID, name: SAMPLE_ROOT_NAME, parentId: null },
    { id: "p-inicio", name: "Inicio", parentId: SAMPLE_ROOT_ID },
    { id: "p-atlas", name: "Atlas", parentId: SAMPLE_ROOT_ID },
    { id: "p-personal", name: "Personal", parentId: SAMPLE_ROOT_ID },
    { id: "p-taller", name: "Taller", parentId: SAMPLE_ROOT_ID },
    { id: "p-diario", name: "Diario", parentId: SAMPLE_ROOT_ID },
  ];

  const documents: Document[] = [
    md(
      "n-inicio",
      "Bienvenida",
      "p-inicio",
      `
# Bienvenida

Grafito guarda notas y archivos dentro de portafolios. No hace falta un Markdown intermedio para relacionar un plano, un PDF o una foto: el vínculo se declara a mano y entra en el grafo.

> [!idea] Dos formas de enlazar
> En una nota, \`[[Diagramas]]\` crea un enlace de texto. En cualquier documento, «Vincular» declara que este archivo referencia o invoca a otro.

## En este portafolio

- [[Cómo escribir]] resume Markdown, tareas y atajos.
- [[Diagramas]] muestra Mermaid y un diagrama C4.
- [[El grafo]] explica líneas continuas, de referencia y de invocación.

El proyecto de ejemplo sigue en [[Mapa del proyecto Atlas]].

- [x] Abrir la bóveda
- [ ] Subir un archivo a un portafolio
- [ ] Vincular ese archivo con una nota

#bienvenida #método
`,
      1,
      true,
      [{ targetId: "n-diagramas", kind: "referencia" }],
    ),
    md(
      "n-escribir",
      "Cómo escribir",
      "p-inicio",
      `
# Cómo escribir

El texto es Markdown. Los vínculos escritos usan doble corchete.

## Enlaces de texto

Escribe \`[[\` y elige una nota: [[Bienvenida|volver al principio]]. Si el destino no existe, al pulsarlo se crea.

Los archivos no se citan así. Se suben al portafolio y se relacionan con **Vincular**.

## Tareas

- [ ] Probar **negrita**, *cursiva* y \`código\`
- [x] Añadir una etiqueta #guía

| Atajo | Hace |
| --- | --- |
| Ctrl o ⌘ K | Paleta |
| Ctrl o ⌘ N | Nota nueva |
| Ctrl o ⌘ E | Editar, dividir o leer |
| Ctrl o ⌘ G | Grafo |

#guía #método
`,
      2,
      true,
    ),
    md(
      "n-diagramas",
      "Diagramas",
      "p-inicio",
      `
# Diagramas

Un bloque \`mermaid\` se dibuja al leer la nota. Sirve para flujos y también para C4: contexto, contenedores, componentes, dinámica y despliegue.

## Flujo

\`\`\`mermaid
flowchart LR
  Autor[Autor] --> Portafolio
  Portafolio --> Nota[Nota Markdown]
  Portafolio --> Archivo
  Nota -->|enlace escrito| Grafo
  Archivo -->|vínculo manual| Grafo
\`\`\`

## Contexto C4

\`\`\`mermaid
C4Context
title Contexto de Grafito
Person(autor, "Autor", "Escribe notas y sube archivos")
System(grafito, "Grafito", "Portafolios, vínculos y grafo")
System_Ext(mermaid, "Mermaid", "Dibuja diagramas, incluido C4")
Rel(autor, grafito, "Organiza")
Rel(grafito, mermaid, "Renderiza")
\`\`\`

## Contenedores

\`\`\`mermaid
C4Container
title Contenedores dentro de Grafito
Person(autor, "Autor", "Usa la bóveda")
Container_Boundary(grafito, "Grafito") {
  Container(notas, "Notas", "Markdown", "Texto, tareas y diagramas")
  Container(archivos, "Archivos", "Binario local", "Planos, PDF e imágenes")
  Container(grafo, "Grafo", "Canvas", "Wiki, referencias e invocaciones")
}
Rel(autor, notas, "Escribe")
Rel(autor, archivos, "Sube")
Rel(notas, grafo, "Enlaza")
Rel(archivos, grafo, "Se vincula")
\`\`\`

## Componentes, dinámica y despliegue

\`\`\`mermaid
C4Component
title Componentes del grafo
Container_Boundary(grafo, "Grafo") {
  Component(wiki, "Enlaces escritos", "Markdown", "Lee wikilinks")
  Component(manual, "Vínculos manuales", "Referencia o invoca", "Une notas y archivos")
  Component(lienzo, "Lienzo", "Canvas", "Dibuja nodos y aristas")
}
Rel(wiki, lienzo, "Alimenta")
Rel(manual, lienzo, "Alimenta")
\`\`\`

\`\`\`mermaid
C4Dynamic
title Abrir un archivo vinculado
Container(nota, "Nota", "Markdown", "El documento abierto")
Container(archivo, "Archivo", "Binario", "Plano, PDF o imagen")
Rel(nota, archivo, "1. El autor elige referencia", "manual")
Rel(archivo, nota, "2. La mención vuelve", "grafo")
\`\`\`

\`\`\`mermaid
C4Deployment
title Dónde vive Grafito
Deployment_Node(navegador, "Navegador", "Este equipo") {
  Container(app, "Grafito", "React", "Portafolios y diagramas")
  ContainerDb(local, "localStorage", "grafito.v2", "Notas, archivos y vínculos")
}
Rel(app, local, "Guarda")
\`\`\`

#guía #diagramas
`,
      3,
      true,
    ),
    md(
      "n-grafo",
      "El grafo",
      "p-inicio",
      `
# El grafo

Cada documento es un nodo, sea nota o archivo. El tipo de línea dice cómo se relacionan.

- Continua: enlace escrito \`[[así]]\`.
- Rayada: «referencia».
- Punteada: «invoca».

[[Bienvenida]] referencia a [[Diagramas]] de forma manual, además de mencionarlo en el texto. En Atlas, la [[Bitácora de campo]] referencia el plano del obrador, y ese archivo invoca a la [[Hipótesis de Atlas]].

#guía #grafo
`,
      4,
    ),
    md(
      "n-mapa",
      "Mapa del proyecto Atlas",
      "p-atlas",
      `
# Mapa del proyecto Atlas

Atlas estudia cómo una ciudad recuerda a través de talleres, cafés y letreros.

1. [[Hipótesis de Atlas]]
2. [[Fuentes]]
3. [[Bitácora de campo]]
4. El plano del obrador, vinculado desde la bitácora sin una nota puente.
5. [[Decisiones abiertas]]

#atlas #mapa
`,
      5,
      true,
    ),
    md(
      "n-hipotesis",
      "Hipótesis de Atlas",
      "p-atlas",
      `
# Hipótesis de Atlas

Los comercios pequeños funcionan como archivo informal.

> [!idea] En una frase
> La memoria urbana está en el mostrador.

La [[Bitácora de campo]] ya tiene escenas. Las [[Fuentes]] empujan en la misma dirección.

#atlas #hipótesis
`,
      6,
    ),
    md(
      "n-fuentes",
      "Fuentes",
      "p-atlas",
      `
# Fuentes

- **Jane Jacobs**, la acera como escenario.
- **Georges Perec**, agotar un lugar mirándolo.
- Notas de la [[Bitácora de campo]].

- [ ] Entrevistar a quien lleve más de diez años en el mismo local
- [x] Separar nostalgia de observación

#atlas #lecturas
`,
      7,
    ),
    md(
      "n-bitacora",
      "Bitácora de campo",
      "p-atlas",
      `
# Bitácora de campo

## 12 de marzo — obrador

La dueña nombra a los clientes por el encargo. El plano del local no es una nota: es un archivo del portafolio, y esta bitácora lo referencia.

Eso encaja con la [[Hipótesis de Atlas]].

## Método

Antes de salir, [[Ritual de la mañana]].

#atlas #campo
`,
      8,
      false,
      [{ targetId: "n-plano", kind: "referencia" }],
    ),
    {
      id: "n-plano",
      title: "Plano del obrador",
      portfolioId: "p-atlas",
      kind: "file",
      content: "",
      file: {
        name: "plano-obrador.svg",
        mime: "image/svg+xml",
        dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(planoSvg)}`,
      },
      links: [{ targetId: "n-hipotesis", kind: "llama" }],
      createdAt: stamp(8),
      updatedAt: stamp(9),
      createdBy: "Administrador",
      updatedBy: "Administrador",
      pinned: false,
    },
    md(
      "n-ritual",
      "Ritual de la mañana",
      "p-personal",
      `
# Ritual de la mañana

1. Abrir el portafolio Diario.
2. Releer la [[Bitácora de campo]].
3. Escribir tres líneas de lo que todavía no entiendo.

> [!quote] Recordatorio
> Si la nota no cambia una idea, sobra.

#método #personal
`,
      9,
    ),
    md(
      "n-decisiones",
      "Decisiones abiertas",
      "p-taller",
      `
# Decisiones abiertas

- ¿Atlas es un ensayo o una serie de escenas?
- ¿La [[Interfaz de lectura]] hereda los vínculos del grafo?

Hasta cerrarlo, el [[Mapa del proyecto Atlas]] sigue en exploración.

#taller #atlas
`,
      10,
    ),
    md(
      "n-lectura",
      "Interfaz de lectura",
      "p-taller",
      `
# Interfaz de lectura

Quien lea el ensayo no tiene por qué ver el grafo, pero puede heredar su estructura: las escenas de la [[Bitácora de campo]] y la [[Hipótesis de Atlas]] al margen.

Cómo se escribe cada pieza está en [[Cómo escribir]]. Los diagramas, en [[Diagramas]].

#taller #lectura
`,
      11,
    ),
    md(
      "n-diario",
      "2026-03-18",
      "p-diario",
      `
# 2026-03-18

Salida al obrador. La escena quedó en la [[Bitácora de campo]]. Retomar el horario de la pizarra con el [[Ritual de la mañana]].

#diario
`,
      18,
    ),
  ];

  return { documents, portfolios, activeId: "n-inicio", mode: "read" };
}
