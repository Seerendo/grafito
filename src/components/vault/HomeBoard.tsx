import { Plus } from "lucide-react";

const QUADS: { kicker: string; title: string; lines: string[] }[] = [
  {
    kicker: "Teclado",
    title: "Atajos",
    lines: [
      "Ctrl K buscar",
      "Ctrl N nota nueva",
      "Ctrl E cambiar de vista",
      "Ctrl G grafo",
      "Ctrl B chat de IA",
      "Esc cierra lo abierto",
    ],
  },
  {
    kicker: "Escritura",
    title: "Notas",
    lines: ["Markdown, [[enlaces]] y #etiquetas.", "El esquema de la derecha se pliega por apartados.", "Descarga la nota en PDF desde el menú."],
  },
  {
    kicker: "Fuera",
    title: "Archivos",
    lines: ["Arrastra desde el computador a un portafolio.", "Un .md entra como nota.", "El resto queda como archivo."],
  },
  {
    kicker: "Mapa",
    title: "Portafolios",
    lines: ["Repliega la barra para escribir con más ancho.", "Raíz vuelve a esta página.", "Clic derecho para crear o mover."],
  },
];

export function HomeBoard({ empty, onCreate }: { empty: boolean; onCreate?: () => void }) {
  return (
    <div data-home className="h-full overflow-y-auto bg-bg px-4 py-8 sm:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-xs font-medium tracking-widest text-faint uppercase">Bóveda</p>
        <h1 className="mt-2 font-serif text-4xl font-semibold tracking-tight">Raíz</h1>
        {empty ? <p className="mt-2 max-w-md text-sm text-muted">Todavía no hay documentos. Esto es lo esencial.</p> : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {QUADS.map((quad) => (
            <section key={quad.title} className="border border-line bg-surface px-4 py-4">
              <p className="text-xs font-medium tracking-widest text-faint uppercase">{quad.kicker}</p>
              <h2 className="mt-1 font-serif text-2xl">{quad.title}</h2>
              <ul className="mt-3 space-y-1.5 text-sm text-muted">
                {quad.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {onCreate ? (
          <button
            type="button"
            onClick={onCreate}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
          >
            <Plus className="size-4" />
            Nueva nota
          </button>
        ) : null}
      </div>
    </div>
  );
}
