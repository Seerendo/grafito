import { Link } from "@tanstack/react-router";
import { Mark } from "@/components/brand/Mark";

/** Página 404 de cualquier ruta que no existe. */
export function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-6 text-fg">
      <div className="text-center">
        <span className="inline-flex items-center gap-0.5">
          <Mark />
          <span className="font-semibold tracking-tight">Grafito</span>
        </span>
        <p className="mt-6 font-serif text-6xl font-semibold tracking-tight">404</p>
        <h1 className="mt-2 font-serif text-2xl">Esta página no existe</h1>
        <Link
          to="/"
          className="mt-6 inline-flex h-11 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
        >
          Volver a la bóveda
        </Link>
      </div>
    </main>
  );
}
